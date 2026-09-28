%% SPDX-License-Identifier: AGPL-3.0-or-later

%% @doc DAVE room state machine (pure).
%%
%% A generic, side-effect-free transition layer shared by the guild voice server
%% and the DM voice processes. Callers feed inbound protocol events plus the
%% results of the crypto RPCs this module requests, and receive back the next
%% room state together with a list of outbound actions to execute (broadcasts,
%% targeted sends, and delivery-service RPCs).
%%
%% Room state shape:
%%   version       :: non_neg_integer()   negotiated DAVE protocol version (0 = passthrough)
%%   established   :: boolean()          whether an MLS group is live
%%   epoch         :: non_neg_integer()   current MLS epoch
%%   key_packages  :: #{UserId => binary()}  accumulated client key packages
%%   joined        :: #{UserId => ConnId | undefined}  clients admitted via the
%%                                     join/negotiation path, tagged with the
%%                                     voice connection generation that was
%%                                     admitted. Stale disconnects from an
%%                                     older generation must not evict a
%%                                     newer membership.
%%   roster        :: [#{user_id, leaf_index}]  last-known post-commit roster
%%   transition    :: undefined | transition()
%%   pending_removals :: [LeafIndex]     batched removal targets awaiting flush
%%   add_queue     :: [op()]            validated joins waiting their turn; a
%%                                     libdave proposals bundle carries exactly
%%                                     one Add, so joins are serialized.
%%                                     Replacements (a rejoining member whose
%%                                     stale leaf must go away alongside the
%%                                     new Add per RFC 9296) ride the same
%%                                     queue as {replace, User, LeafIndex}.
%%
%% A transition() is:
%%   #{id, phase, ready_set, target_users, added_users, deadline_ms,
%%     proposals_b64, initiated_by}
%%   phase: preparing | executing | awaiting_commit
%%   target_users: everyone expected to report ready_for_transition (all
%%     committing members plus welcomed users). added_users: the subset being
%%     welcomed, which must NOT receive the proposals bundle (their own-add
%%     collides with the join key in their pending group).
%%
%% All UserIds are binaries (decimal snowflakes); all opaque MLS bytes are
%% binaries (base64 already decoded by the transport or kept as-is — this
%% module treats them as opaque).

-module(voice_dave_coordinator).
-typing([eqwalizer]).

-export([
    new_room_state/2,
    handle/2
]).

-export_type([room_state/0, action/0]).

-define(K_INIT_TRANSITION_ID, 0).
-define(K_DEFAULT_TRANSITION_DURATION_MS, 10000).
-define(K_REMOVE_BATCH_WINDOW_MS, 500).

-type user_id() :: binary().
-type conn_id() :: binary() | undefined.
-type roster_entry() :: #{user_id => user_id(), leaf_index => non_neg_integer()}.
-type queued_op() :: {add, user_id()} | {replace, user_id(), non_neg_integer()}.
-type action() ::
    {send_to_user, user_id(), map()}
    | {dave_rpc, atom(), map(), reference()}
    | {schedule_timer, term(), pos_integer()}
    | {log_warning, term()}.

-type transition_phase() :: preparing | awaiting_commit | executing.

-type transition() :: #{
    id := non_neg_integer(),
    phase := transition_phase(),
    ready_set := #{user_id() => true},
    target_users := [user_id()],
    added_users := [user_id()],
    deadline_ms := pos_integer(),
    proposals_b64 => binary(),
    initiated_by => user_id() | undefined
}.

-type room_state() :: #{
    group_id := binary(),
    version => non_neg_integer(),
    established => boolean(),
    epoch => non_neg_integer(),
    key_packages => #{user_id() => binary()},
    pending_kps => #{user_id() => binary()},
    joined => #{user_id() => conn_id()},
    roster := [roster_entry()],
    transition => undefined | transition(),
    pending_removals => [non_neg_integer()],
    replace_pending => #{user_id() => non_neg_integer()},
    add_queue => [queued_op()],
    next_transition_id => non_neg_integer()
}.

%% @doc Fresh room state. `Established' reflects whether the channel already has
%% an active MLS group (from persistence); callers start with `false'.
-spec new_room_state(boolean(), binary()) -> room_state().
new_room_state(Established, GroupIdBin) ->
    #{
        group_id => GroupIdBin,
        version => 0,
        established => Established,
        epoch => 0,
        key_packages => #{},
        pending_kps => #{},
        joined => #{},
        roster => [],
        transition => undefined,
        pending_removals => [],
        replace_pending => #{},
        add_queue => [],
        next_transition_id => 1
    }.

%% --------------------------------------------------------------------------
%% Join / version negotiation
%% --------------------------------------------------------------------------

handle({join, UserId, MaxVersion, ConnId}, State) when is_binary(UserId), is_integer(MaxVersion) ->
    %% Record the admission, tagged with the voice connection generation.
    %% Opcode-17 client events are only honored for users in this set; the
    %% join/move/token flows run their real permission checks *before*
    %% driving {join, _, _, _} with the authenticated session user, so
    %% membership here is itself the authorization proof.
    Joined0 = maps:get(joined, State, #{}),
    case maps:get(UserId, Joined0, undefined) of
        ConnId when is_binary(ConnId) ->
            %% Duplicate negotiation for the same connection generation (token
            %% retry racing its own ack). Re-acking would reset a client that
            %% may already be mid-handshake or established on this generation.
            {State, []};
        _Prev ->
            StateA = State#{joined => Joined0#{UserId => ConnId}},
            StateB = retire_user_key_material(StateA, UserId),
            %% A rejoin while the previous incarnation is still in the live
            %% roster records the replacement intent: once the fresh key
            %% package validates, one transition removes the stale leaf and
            %% adds the new representation (RFC 9296, invalid/rejoin
            %% handling). Solo rejoiners just re-found through the normal
            %% founding path instead of being removed from an emptying group.
            RosterUsers = roster_users(StateB),
            StateC =
                case
                    maps:get(established, StateB, false) andalso
                        lists:member(UserId, RosterUsers) andalso
                        length(RosterUsers) > 1
                of
                    false ->
                        StateB;
                    true ->
                        OldLeaf = find_leaf(UserId, maps:get(roster, StateB, [])),
                        %% The atomic replace transition removes this stale
                        %% leaf itself. Drop it from the batched removal window
                        %% so a later flush cannot remove whatever new leaf
                        %% ends up at that index after the flip.
                        CleanedRemovals =
                            case OldLeaf of
                                undefined ->
                                    maps:get(pending_removals, StateB, []);
                                LI ->
                                    [X || X <- maps:get(pending_removals, StateB, []), X =/= LI]
                            end,
                        StateB#{
                            pending_removals => CleanedRemovals,
                            replace_pending =>
                                maps:put(UserId, OldLeaf, maps:get(replace_pending, StateB, #{}))
                        }
                end,
            negotiate_join_version(StateC, UserId, MaxVersion)
    end;

%% --------------------------------------------------------------------------
%% External sender package delivered from the API back to a joining client.
%% --------------------------------------------------------------------------
handle({sender_package_result, UserId, SenderPkgB64}, State) ->
    {State, [
        {send_to_user, UserId, #{
            type => external_sender_package,
            data => SenderPkgB64
        }}
    ]};

%% --------------------------------------------------------------------------
%% Key package arrival — drives group founding or member-add.
%% --------------------------------------------------------------------------
handle({key_package, UserId, KpB64}, State) ->
    case is_admitted(UserId, State) of
        true ->
            %% Park the package unvalidated and ask the delivery service to check
            %% its signature, ciphersuite and identity binding. Only VALIDATED
            %% key packages may ever be signed into MLS add proposals.
            Pending = maps:get(pending_kps, State, #{}),
            Ref = make_ref(),
            {State#{pending_kps => Pending#{UserId => KpB64}}, [
                {dave_rpc, validate_key_package, #{
                    key_package_b64 => KpB64,
                    user_id => UserId
                }, {Ref, UserId}}
            ]};
        false ->
            {State, [{log_warning, {dave_unauthorized_sender, key_package, UserId}}]}
    end;

%% --------------------------------------------------------------------------
%% Proposal bundle created by the delivery service.
%% --------------------------------------------------------------------------
handle({proposals_created, ProposalsB64}, State) ->
    case maps:get(transition, State, undefined) of
        undefined ->
            {State, []};
        T = #{phase := preparing} ->
            %% Existing members receive the proposals bundle and race to
            %% commit it. The added user(s) must NOT receive it: processing
            %% an Add of their own key package collides with the join key
            %% already present in their pending group ("Duplicate encryption
            %% key"); their membership arrives via Welcome instead.
            %% Fan-out is computed from the *live* state — the old
            %% driver-level MemberProvider closure captured the pre-event
            %% room snapshot and delivered founding proposals to nobody.
            Payload = #{
                type => proposals,
                transition_id => maps:get(id, T),
                data => ProposalsB64
            },
            AddedUsers = maps:get(added_users, T, []),
            Recipients = lists:usort(roster_users(State) ++ all_present_users(State)) -- AddedUsers,
            Sends = [{send_to_user, U, Payload} || U <- Recipients],
            T1 = T#{proposals_b64 => ProposalsB64, phase => awaiting_commit},
            {State#{transition => T1}, Sends}
    end;

%% --------------------------------------------------------------------------
%% A committing client returned its commit/welcome bundle; ask the DS to parse it.
%% The parse result arrives via {commit_parsed, ...}.
%% --------------------------------------------------------------------------
handle({commit_welcome, CommitterId, BundleB64}, State) ->
    case is_admitted(CommitterId, State) of
        false ->
            {State, [{log_warning, {dave_unauthorized_sender, commit_welcome, CommitterId}}]};
        true ->
            case maps:get(transition, State, undefined) of
                T = #{phase := awaiting_commit, proposals_b64 := ProposalsB64} ->
                    Epoch = maps:get(epoch, State, 0),
                    KnownRoster = maps:get(roster, State, []),
                    Ref = make_ref(),
                    %% Remember who committed so the parsed handler can exclude them
                    %% from welcome targets (they joined via their own commit).
                    State1 = State#{transition => T#{initiated_by => CommitterId}},
                    {State1, [
                        {dave_rpc, parse_commit, #{
                            group_id => maps:get(group_id, State, <<>>),
                            expected_epoch => Epoch,
                            committer_user_id => CommitterId,
                            commit_welcome_b64 => BundleB64,
                            pending_proposals_b64 => ProposalsB64,
                            known_roster => KnownRoster
                        }, {Ref, CommitterId}}
                    ]};
                _ ->
                    {State, []}
            end
    end;

%% First valid parsed commit wins the epoch.
handle({commit_parsed, ok, Parsed}, State) ->
    T = maps:get(transition, State, undefined),
    NewEpoch = maps:get(new_epoch, Parsed, maps:get(epoch, State, 0) + 1),
    Roster = maps:get(roster, Parsed, maps:get(roster, State, [])),
    WelcomeB64 = maps:get(welcome_b64, Parsed, undefined),
    CommitB64 = maps:get(commit_b64, Parsed, <<>>),
    %% The DAVE delivery service echoes the winning commit to every connected
    %% participant, the committer included: clients only *apply* the winning
    %% commit through this echo (ProcessProposals merely builds a candidate),
    %% so any excluded member would stay on the old epoch and fail to decrypt
    %% post-transition media. Welcomes go only to the newly added members.
    %% The winning commit is echoed to the members that existed *before*
    %% this transition: they apply it through the echo. Newly added users
    %% get a Welcome instead and must never process the commit themselves.
    PrevMembers = [U || #{user_id := U} <- maps:get(roster, State, [])],
    %% The transition's own added_users list is authoritative for who must be
    %% welcomed vs echoed. A plain roster diff cannot tell the difference for a
    %% *replace* transition: the rejoining user appears in both the old and the
    %% new roster, yet they must receive a Welcome (their stale leaf was removed
    %% and the new leaf needs the epoch secret), never the echoed commit.
    AddedUsers = added_users_for(T),
    EchoUsers = lists:usort(PrevMembers -- AddedUsers),
    Announce = [
        {send_to_user, U, #{
            type => announce_commit_transition,
            transition_id => trans_id(T),
            data => CommitB64
        }}
     || U <- EchoUsers
    ],
    Welcomes =
        case WelcomeB64 of
            undefined ->
                [];
            _ ->
                Committer = initiated_by(T),
                Adds = AddedUsers -- [Committer],
                [
                    {send_to_user, U, #{
                        type => welcome,
                        transition_id => trans_id(T),
                        data => WelcomeB64
                    }}
                 || U <- Adds
                ]
        end,
    %% A replace transition consumed its replacement intent when it started;
    %% clear it now that the new roster is authoritative.
    Replaced =
        case T of
            undefined -> #{};
            _ -> maps:get(added_users, T, [])
        end,
    State1 = State#{
        epoch => NewEpoch,
        established => true,
        roster => Roster,
        transition => undefined,
        replace_pending => maps:without(Replaced, maps:get(replace_pending, State, #{}))
    },
    drain_next_op(State1, Announce ++ Welcomes);

handle({commit_parsed, error, _Reason}, State) ->
    %% Losing/invalid commit; leave current transition intact so another may win.
    {State, []};

%% --------------------------------------------------------------------------
%% Transition readiness counting.
%% --------------------------------------------------------------------------
handle({ready_for_transition, UserId, TransitionId}, State) ->
    case is_admitted(UserId, State) of
        false ->
            {State, [{log_warning, {dave_unauthorized_sender, ready_for_transition, UserId}}]};
        true ->
            case maps:get(transition, State, undefined) of
                T = #{id := TransitionId, ready_set := Ready} ->
                    Ready1 = Ready#{UserId => true},
                    TargetUsers = target_users_for(T),
                    AllReady = lists:all(fun(U) -> maps:is_key(U, Ready1) end, TargetUsers),
                    T1 = T#{ready_set => Ready1},
                    case AllReady of
                        true ->
                            {SE, AE} = execute_transition(State#{transition => T1}),
                            drain_next_op(SE, AE);
                        false ->
                            {State#{transition => T1}, []}
                    end;
                _ ->
                    {State, []}
            end
    end;

%% Deadline elapsed (host timer fired) — force-execute if we still have a live
%% awaiting_commit transition; a transition whose proposals were never created
%% (DS RPC lost/failed while still 'preparing') is cancelled so the slot frees
%% for the next queued operation instead of wedging the room forever.
handle({transition_timeout, TransitionId}, State) ->
    case maps:get(transition, State, undefined) of
        _T = #{id := TransitionId, phase := awaiting_commit} ->
            {SE, AE} = execute_transition(State),
            drain_next_op(SE, AE);
        _T = #{id := TransitionId, phase := preparing} ->
            State1 = State#{transition => undefined},
            drain_next_op(State1, [{log_warning, {dave_transition_cancelled_no_proposals, TransitionId}}]);
        _ ->
            {State, []}
    end;

%% --------------------------------------------------------------------------
%% Invalid commit/welcome from a member -> RFC 9296 recovery: the flagging
%% member is returned to pending state (their key material is dropped so a
%% fresh key package must arrive) and their live leaf is removed from the
%% group. The rest of the room keeps its established group — a full-room
%% reset here would thrash every member's session for one bad transition.
%% --------------------------------------------------------------------------
handle({invalid_commit_welcome, UserId}, State) ->
    case is_admitted(UserId, State) of
        false ->
            {State, [{log_warning, {dave_unauthorized_sender, invalid_commit_welcome, UserId}}]};
        true ->
            State1 = retire_user_key_material(State, UserId),
            case find_leaf(UserId, maps:get(roster, State1, [])) of
                undefined ->
                    %% Not in the live group (e.g. a pending joiner whose
                    %% welcome failed): dropping their key material is all
                    %% there is to do; the fresh key package they upload
                    %% restarts the add flow.
                    {State1, []};
                LeafIndex ->
                    Remaining = [
                        U
                     || #{user_id := U} <- maps:get(roster, State1, []),
                        U =/= UserId
                    ],
                    case {Remaining, maps:get(established, State1, false)} of
                        {[], true} ->
                            %% The flagger was the only roster member: the
                            %% group is worthless. Reset so they re-found.
                            State2 = reset_to_unestablished(State1),
                            Actions = [
                                {send_to_user, UserId, #{
                                    type => prepare_epoch,
                                    epoch => 1,
                                    version => maps:get(version, State2, 0)
                                }},
                                {send_to_user, UserId, #{
                                    type => prepare_transition,
                                    transition_id => ?K_INIT_TRANSITION_ID,
                                    version => maps:get(version, State2, 0)
                                }}
                            ],
                            {State2, Actions};
                        _ ->
                            schedule_removal_with(UserId, LeafIndex, State1)
                    end
            end
    end;

%% --------------------------------------------------------------------------
%% Sole-member reset: only one member remains -> prepare_epoch(1) + prepare(0).
%% --------------------------------------------------------------------------
handle({member_left, UserId, ConnId}, State) ->
    Joined = maps:get(joined, State, #{}),
    case maps:get(UserId, Joined, undefined) of
        Current when Current =:= ConnId; ConnId =:= undefined; Current =:= undefined ->
            %% Retire the departed user's admission and key package right
            %% away: ghosts in `joined' would keep passing the authorization
            %% gate, and ghosts in `key_packages' would count as present for
            %% future founding rounds and echo broadcasts.
            StateR = State#{
                joined => maps:remove(UserId, Joined),
                key_packages => maps:remove(UserId, maps:get(key_packages, State, #{})),
                pending_kps => maps:remove(UserId, maps:get(pending_kps, State, #{})),
                replace_pending => maps:remove(UserId, maps:get(replace_pending, State, #{})),
                add_queue => [Op || Op <- maps:get(add_queue, State, []), op_user(Op) =/= UserId]
            },
            Members = all_present_users(StateR),
            Remaining = Members -- [UserId],
            case Remaining =:= [] andalso maps:get(established, StateR, false) of
                true ->
                    %% The last connected member is gone: nothing remains to
                    %% maintain the group, so tear it down for a clean future
                    %% founding.
                    {reset_to_unestablished(StateR), []};
                false ->
                    %% Stayers remain. Keep the live group intact and schedule
                    %% only the departed leaf for removal. Tearing the whole
                    %% room down here (the old sole-reset) wiped the stayers'
                    %% key packages, so a later rejoin of the departed user
                    %% founds a brand-new group the stayer is never added back
                    %% to — two isolated MLS groups with no audio either way.
                    schedule_removal(UserId, StateR)
            end;
        Other ->
            %% A disconnect belonging to an older (or unknown) connection
            %% generation. The user has already rejoined with a newer one;
            %% evicting their admission/key material now would kill the live
            %% session with a stale departure notice.
            {State, [{log_warning, {dave_stale_member_left_ignored, UserId, Other}}]}
    end;

%% Flush the batched removal window -> create the remove proposals. If a
%% transition is already live the flush must NOT clobber it (that would drop
%% the in-flight transition's ready-set and wedge its welcomed members), so
%% the window is simply re-armed.
handle(flush_removals, State) ->
    case maps:get(transition, State, undefined) of
        undefined ->
            case maps:get(pending_removals, State, []) of
                [] ->
                    {State, []};
                Indices ->
                    State1 = State#{pending_removals => []},
                    start_remove_transition(State1, Indices)
            end;
        _Active ->
            {State, [{schedule_timer, flush_removals, ?K_REMOVE_BATCH_WINDOW_MS}]}
    end;

%% A validate-key-package result reported back by the host. Validation success
%% promotes the parked package into the live set and drives founding / member-add.
handle({validate_key_package_result, UserId, #{valid := true}}, State) ->
    Pending = maps:get(pending_kps, State, #{}),
    case maps:take(UserId, Pending) of
        {KpB64, Pending1} ->
            Kps = maps:get(key_packages, State, #{}),
            State1 = State#{pending_kps => Pending1, key_packages => Kps#{UserId => KpB64}},
            Established = maps:get(established, State1, false),
            ReplacePending = maps:get(replace_pending, State1, #{}),
            case maps:take(UserId, ReplacePending) of
                {OldLeaf, Replace1} ->
                    State2 = State1#{replace_pending => Replace1},
                    %% Rejoin replacement: remove the stale leaf and add the
                    %% fresh key package in one bundle so the user's
                    %% representation flips atomically across the epoch bump.
                    case maps:get(transition, State2, undefined) of
                        undefined ->
                            start_replace_transition(State2, UserId, OldLeaf, KpB64);
                        _Active ->
                            enqueue_op(State2, {replace, UserId, OldLeaf})
                    end;
                error ->
                    case {Established, maps:get(transition, State1, undefined)} of
                        {false, undefined} ->
                            %% Founding: the first validated member *is* the seed
                            %% leaf of their own pending MLS group. Issuing an Add
                            %% for them would collide with that leaf inside libdave
                            %% ("Duplicate encryption key"), so founding is
                            %% recorded directly; queued co-joiners proceed as
                            %% real single-target adds afterwards.
                            Founded = State1#{
                                established => true,
                                epoch => 0,
                                roster => [#{user_id => UserId, leaf_index => 0}]
                            },
                            drain_next_op(Founded, []);
                        _ ->
                            %% Already established (or a transition is still
                            %% live): one Add per bundle, gated through the queue.
                            maybe_start_add(State1, [UserId])
                    end
            end;
        error ->
            %% Stale or duplicate result; ignore.
            {State, []}
    end;
handle({validate_key_package_result, UserId, #{valid := false, reason := Reason}}, State) ->
    %% Drop the offending key package; nothing else to do (client will retry).
    Pending = maps:get(pending_kps, State, #{}),
    {State#{pending_kps => maps:remove(UserId, Pending)},
        [{log_warning, {bad_key_package, UserId, Reason}}]}.

%% --------------------------------------------------------------------------
%% Internal helpers
%% --------------------------------------------------------------------------

%% Version-floor selection + ack + sender package fetch, shared by first-time
%% joins and rejoins (the generation bookkeeping happens in the caller).
-spec negotiate_join_version(room_state(), user_id(), non_neg_integer()) ->
    {room_state(), [action()]}.
negotiate_join_version(State, UserId, MaxVersion) ->
    ExistingVersion = maps:get(version, State, 0),
    Established = maps:get(established, State, false),
    case Established andalso ExistingVersion > 0 andalso MaxVersion < ExistingVersion of
        true ->
            %% A live MLS group is bound to its negotiated protocol version; a
            %% member whose maximum sits below it cannot join that key schedule.
            %% Per RFC 9296 the delivery service falls back: discard the group
            %% and re-found at the new common floor instead of silently
            %% corrupting the version under a live group.
            Members = lists:usort(all_present_users(State) ++ [UserId]),
            State1 = State#{
                version => MaxVersion,
                established => false,
                epoch => 0,
                transition => undefined,
                key_packages => #{},
                roster => [],
                pending_removals => [],
                replace_pending => #{},
                add_queue => []
            },
            Reinit = [
                {send_to_user, U, #{
                    type => prepare_epoch,
                    epoch => 1,
                    version => MaxVersion
                }}
             || U <- Members, U =/= UserId
            ],
            Ack = #{
                type => select_protocol_ack,
                version => MaxVersion,
                target_user_id => UserId
            },
            Ref = make_ref(),
            {State1, [{send_to_user, UserId, Ack} | Reinit] ++ [{dave_rpc, sender_package, #{}, {Ref, UserId}}]};
        false ->
            %% Choose the highest version supported by every e2ee-required
            %% participant. For a new (unestablished) room the joiner's own
            %% max becomes the floor.
            Negotiated =
                case ExistingVersion of
                    0 -> MaxVersion;
                    V -> min(V, MaxVersion)
                end,
            State1 = State#{version => Negotiated},
            Ack = #{
                type => select_protocol_ack,
                version => Negotiated,
                target_user_id => UserId
            },
            case Negotiated > 0 of
                true ->
                    %% Ask the delivery service for the external sender package for this user.
                    Ref = make_ref(),
                    {State1, [
                        {send_to_user, UserId, Ack},
                        {dave_rpc, sender_package, #{}, {Ref, UserId}}
                    ]};
                false ->
                    %% Passthrough: no DAVE ops, just the ack with version 0.
                    {State1, [{send_to_user, UserId, Ack}]}
            end
    end.

%% Drop everything a user's previous incarnation contributed to the MLS room.
%% Admission itself is (re)set by the caller.
-spec retire_user_key_material(room_state(), user_id()) -> room_state().
retire_user_key_material(State, UserId) ->
    State#{
        key_packages => maps:remove(UserId, maps:get(key_packages, State, #{})),
        pending_kps => maps:remove(UserId, maps:get(pending_kps, State, #{}))
    }.

%% Gate: only one MLS transition may be live at a time. Extra targets wait in
%% `add_queue' (arrival order, deduplicated) and are released one per completed
%% transition by drain_next_op/2. Targets that are *live* roster members are
%% dropped: a duplicate key-package validation for an existing member must not
%% produce a second Add (libdave rejects it as 'Duplicate encryption key').
%% Members whose leaf is already scheduled for removal or replacement are NOT
%% live — a rejoiner in that state must be able to queue their re-add.
-spec maybe_start_add(room_state(), [user_id()]) -> {room_state(), [action()]}.
maybe_start_add(State0, Targets0) ->
    Targets = Targets0 -- live_members(State0),
    case Targets of
        [] ->
            {State0, []};
        _ ->
            case maps:get(transition, State0, undefined) of
                undefined ->
                    start_add_transition(State0, Targets);
                _Active ->
                    Queue0 = maps:get(add_queue, State0, []),
                    Queue1 = Queue0 ++ [
                        {add, U}
                     || U <- Targets, not lists:any(fun(Op) -> op_user(Op) =:= U end, Queue0)
                    ],
                    {State0#{add_queue => Queue1}, []}
            end
    end.

%% Users who are in the roster AND not pending removal/replacement.
-spec live_members(room_state()) -> [user_id()].
live_members(State) ->
    Removing = removal_pending_users(State),
    [U || U <- roster_users(State), not lists:member(U, Removing)].

%% Roster users whose leaf is either in the batched removal window or marked
%% for atomic replacement.
-spec removal_pending_users(room_state()) -> [user_id()].
removal_pending_users(State) ->
    Roster = maps:get(roster, State, []),
    Indices = maps:get(pending_removals, State, []),
    Batched = [U || #{user_id := U, leaf_index := LI} <- Roster, lists:member(LI, Indices)],
    Replacing = maps:keys(maps:get(replace_pending, State, #{})),
    lists:usort(Batched ++ Replacing).

%% Enqueue an op behind the currently live transition, deduplicating by user.
-spec enqueue_op(room_state(), queued_op()) -> {room_state(), [action()]}.
enqueue_op(State, Op) ->
    Queue0 = maps:get(add_queue, State, []),
    case lists:any(fun(Q) -> op_user(Q) =:= op_user(Op) end, Queue0) of
        true ->
            {State, []};
        false ->
            {State#{add_queue => Queue0 ++ [Op]}, []}
    end.

%% Release exactly one queued op (the caller just freed the transition slot).
%% Releasing more than one eagerly would sign overlapping proposals for the
%% same epoch before the previous transition's welcome has been delivered.
%% Ops that became stale while queued are discarded here:
%%  - {add, U}: U is already a live member (duplicate validations racing the
%%    active transition landed them in the roster).
%%  - {replace, U, Idx}: U is no longer rostered at Idx (a plain removal got
%%    there first) -> convert to a plain add; or U is already live elsewhere.
-spec drain_next_op(room_state(), [action()]) -> {room_state(), [action()]}.
drain_next_op(State, Actions) ->
    case maps:get(add_queue, State, []) of
        [] ->
            {State, Actions};
        [Op | Rest] ->
            State1 = State#{add_queue => Rest},
            case normalize_queued_op(State1, Op) of
                skip ->
                    drain_next_op(State1, Actions);
                {add, U} ->
                    {S1, A1} = start_add_transition(State1, [U]),
                    {S1, Actions ++ A1};
                {replace, U, Idx} ->
                    Kp = maps:get(U, maps:get(key_packages, State1, #{}), <<>>),
                    {S1, A1} = start_replace_transition(State1, U, Idx, Kp),
                    {S1, Actions ++ A1}
            end
    end.

-spec normalize_queued_op(room_state(), queued_op()) -> queued_op() | skip.
normalize_queued_op(State, {add, U}) ->
    case lists:member(U, live_members(State)) of
        true ->
            skip;
        false ->
            {add, U}
    end;
normalize_queued_op(State, {replace, U, Idx} = Op) ->
    Roster = maps:get(roster, State, []),
    case find_leaf(U, Roster) of
        Idx ->
            Op;
        Other when is_integer(Other) ->
            %% Leaf shifted under us (tree compaction after other removals):
            %% remove wherever it lives now.
            {replace, U, Other};
        undefined ->
            %% The stale leaf is already gone; a plain add achieves the same.
            {add, U}
    end.

-spec roster_users(room_state()) -> [user_id()].
roster_users(State) ->
    [U || #{user_id := U} <- maps:get(roster, State, [])].

-spec op_user(queued_op()) -> user_id().
op_user({add, U}) -> U;
op_user({replace, U, _Idx}) -> U.

-spec start_add_transition(room_state(), [user_id()]) -> {room_state(), [action()]}.
start_add_transition(State, TargetUsers) ->
    Id = next_trans_id(State),
    Epoch = maps:get(epoch, State, 0),
    AddB64 = [maps:get(U, maps:get(key_packages, State, #{}), <<>>) || U <- TargetUsers],
    %% Everyone except the welcomed users commits; the welcomed users must
    %% still report ready (after their welcome) before the gateway executes.
    Recipients = lists:usort(roster_users(State) ++ all_present_users(State)) -- TargetUsers,
    ReadyTargets = lists:usort(Recipients ++ TargetUsers),
    T = #{
        id => Id,
        phase => preparing,
        ready_set => #{},
        target_users => ReadyTargets,
        added_users => TargetUsers,
        deadline_ms => ?K_DEFAULT_TRANSITION_DURATION_MS,
        initiated_by => undefined
    },
    State1 = State#{transition => T, next_transition_id => Id + 1},
    %% Ask the DS to sign add proposals for the targets.
    {State1, [
        {schedule_timer, {transition_timeout, Id}, ?K_DEFAULT_TRANSITION_DURATION_MS},
        {dave_rpc, create_proposals, #{
            group_id => maps:get(group_id, State, <<>>),
            epoch => Epoch,
            add_b64 => AddB64,
            remove_indices => []
        }, make_ref()}
    ]}.

-spec start_replace_transition(room_state(), user_id(), non_neg_integer(), binary()) ->
    {room_state(), [action()]}.
start_replace_transition(State, UserId, OldLeafIndex, KpB64) ->
    Id = next_trans_id(State),
    Epoch = maps:get(epoch, State, 0),
    RemovedUser =
        case [U || #{user_id := U, leaf_index := LI} <- maps:get(roster, State, []), LI =:= OldLeafIndex] of
            [RU | _] -> RU;
            [] -> UserId
        end,
    %% The replaced user is welcomed into the new epoch; they must not see the
    %% bundle. Everyone else (minus the removed representation) commits.
    Recipients = lists:usort((roster_users(State) ++ all_present_users(State)) -- [RemovedUser]) -- [UserId],
    ReadyTargets = lists:usort(Recipients ++ [UserId]),
    T = #{
        id => Id,
        phase => preparing,
        ready_set => #{},
        target_users => ReadyTargets,
        added_users => [UserId],
        deadline_ms => ?K_DEFAULT_TRANSITION_DURATION_MS,
        initiated_by => undefined
    },
    State1 = State#{transition => T, next_transition_id => Id + 1},
    {State1, [
        {schedule_timer, {transition_timeout, Id}, ?K_DEFAULT_TRANSITION_DURATION_MS},
        {dave_rpc, create_proposals, #{
            group_id => maps:get(group_id, State, <<>>),
            epoch => Epoch,
            add_b64 => [KpB64],
            remove_indices => [OldLeafIndex]
        }, make_ref()}
    ]}.

-spec start_remove_transition(room_state(), [non_neg_integer()]) -> {room_state(), [action()]}.
start_remove_transition(State, RemoveIndices) ->
    Id = next_trans_id(State),
    Epoch = maps:get(epoch, State, 0),
    Roster = maps:get(roster, State, []),
    RemovedUsers = [U || #{user_id := U, leaf_index := LI} <- Roster, lists:member(LI, RemoveIndices)],
    %% Departed members are neither asked to commit nor awaited; the people
    %% staying must drive the transition and report ready.
    RemainingTargets = lists:usort((roster_users(State) ++ all_present_users(State)) -- RemovedUsers),
    T = #{
        id => Id,
        phase => preparing,
        ready_set => #{},
        target_users => RemainingTargets,
        added_users => [],
        deadline_ms => ?K_DEFAULT_TRANSITION_DURATION_MS,
        initiated_by => undefined
    },
    {State#{transition => T, next_transition_id => Id + 1}, [
        {schedule_timer, {transition_timeout, Id}, ?K_DEFAULT_TRANSITION_DURATION_MS},
        {dave_rpc, create_proposals, #{
            group_id => maps:get(group_id, State, <<>>),
            epoch => Epoch,
            add_b64 => [],
            remove_indices => RemoveIndices
        }, make_ref()}
    ]}.

-spec schedule_removal(user_id(), room_state()) -> {room_state(), [action()]}.
schedule_removal(UserId, State) ->
    case find_leaf(UserId, maps:get(roster, State, [])) of
        undefined ->
            {State, []};
        LeafIndex ->
            schedule_removal_with(UserId, LeafIndex, State)
    end.

-spec schedule_removal_with(user_id(), non_neg_integer(), room_state()) -> {room_state(), [action()]}.
schedule_removal_with(_UserId, LeafIndex, State) ->
    Pending = maps:get(pending_removals, State, []),
    WasEmpty = Pending =:= [],
    State1 = State#{pending_removals => Pending ++ [LeafIndex]},
    Actions =
        case WasEmpty of
            true -> [{schedule_timer, flush_removals, ?K_REMOVE_BATCH_WINDOW_MS}];
            false -> []
        end,
    {State1, Actions}.

-spec execute_transition(room_state()) -> {room_state(), [action()]}.
execute_transition(State) ->
    T = maps:get(transition, State, undefined),
    Id = trans_id(T),
    Version = maps:get(version, State, 0),
    TargetUsers = target_users_for(T),
    State1 =
        case Version of
            0 -> State#{established => false, transition => undefined};
            _ -> State#{transition => undefined}
        end,
    Actions = [
        {send_to_user, U, #{type => execute_transition, transition_id => Id, version => Version}}
     || U <- TargetUsers
    ],
    {State1, Actions}.

reset_to_unestablished(State) ->
    State#{
        established => false,
        epoch => 0,
        key_packages => #{},
        roster => [],
        transition => undefined,
        pending_removals => [],
        replace_pending => #{},
        add_queue => []
    }.

all_present_users(State) ->
    %% Users with a key package are the connected set for protocol purposes.
    maps:keys(maps:get(key_packages, State, #{})).

%% Users admitted through the owning process' join/negotiation path. Client
%% originated opcode-17 events are only honored for members of this set.
-spec is_admitted(user_id(), room_state()) -> boolean().
is_admitted(UserId, State) ->
    maps:is_key(UserId, maps:get(joined, State, #{})).

find_leaf(UserId, Roster) ->
    case [LI || #{user_id := U, leaf_index := LI} <- Roster, U =:= UserId] of
        [LI | _] -> LI;
        [] -> undefined
    end.

trans_id(undefined) -> ?K_INIT_TRANSITION_ID;
trans_id(T) -> maps:get(id, T, ?K_INIT_TRANSITION_ID).

initiated_by(undefined) -> undefined;
initiated_by(T) -> maps:get(initiated_by, T, undefined).

added_users_for(undefined) -> [];
added_users_for(T) -> maps:get(added_users, T, []).

target_users_for(undefined) -> [];
target_users_for(T) -> maps:get(target_users, T, []).

next_trans_id(State) -> maps:get(next_transition_id, State, 1).
%% ==========================================================================
%% Tests
%% ==========================================================================
-ifdef(TEST).
-include_lib("eunit/include/eunit.hrl").

find_send(Actions, UserId) ->
    [A || {send_to_user, U, A} <- Actions, U =:= UserId].

has_rpc(Actions, Method) ->
    lists:any(fun({dave_rpc, M, _, _}) -> M =:= Method; (_) -> false end, Actions).

rpc_args(Actions, Method) ->
    case [{Args, Ref} || {dave_rpc, M, Args, Ref} <- Actions, M =:= Method] of
        [{Args, Ref} | _] -> {Args, Ref};
        [] -> undefined
    end.

%% Count send/broadcast actions whose payload carries the given DAVE event type.
count_type(Actions, Type) ->
    length([
        X
     || X <- Actions,
        case X of
            {send_to_user, _, #{type := T}} -> T =:= Type;
            _ -> false
        end
    ]).

has_timer(Actions, Msg) ->
    lists:any(fun({schedule_timer, M, _}) -> M =:= Msg; (_) -> false end, Actions).

negotiation_test() ->
    S0 = new_room_state(false, <<"42">>),
    %% New room adopts the joiner's max version and requests the sender package.
    {S1, A1} = handle({join, <<"1001">>, 1, <<"c1001">>}, S0),
    ?assertEqual(1, maps:get(version, S1)),
    ?assert(has_rpc(A1, sender_package)),
    [Ack] = find_send(A1, <<"1001">>),
    ?assertEqual(select_protocol_ack, maps:get(type, Ack)),
    ?assertEqual(1, maps:get(version, Ack)),
    %% Second joiner with lower max lowers the negotiated version.
    {_S2, A2} = handle({join, <<"1002">>, 0, <<"c1002">>}, S1),
    [Ack2] = find_send(A2, <<"1002">>),
    ?assertEqual(0, maps:get(version, Ack2)).

passthrough_no_sender_package_test() ->
    S0 = new_room_state(false, <<"42">>),
    {S1, A1} = handle({join, <<"1001">>, 0, <<"c1001">>}, S0),
    ?assertEqual(0, maps:get(version, S1)),
    ?assertNot(has_rpc(A1, sender_package)),
    ?assertEqual(1, length(A1)).

%% A repeated negotiation for the SAME connection generation must not re-ack:
%% the client may already be mid-handshake on this generation and a second
%% select_protocol_ack would reset its session.
duplicate_same_generation_join_is_noop_test() ->
    S0 = (new_room_state(false, <<"42">>))#{
        version => 1,
        joined => #{<<"1001">> => <<"c1001">>}
    },
    {S1, A1} = handle({join, <<"1001">>, 1, <<"c1001">>}, S0),
    ?assertEqual(S0, S1),
    ?assertEqual([], A1).

founding_from_first_key_package_test() ->
    S0 = (new_room_state(false, <<"42">>))#{
        version => 1,
        joined => #{<<"1001">> => <<"c1001">>},
        pending_kps => #{<<"1001">> => <<"KPA">>}
    },
    {S1, A1} = handle({validate_key_package_result, <<"1001">>, #{valid => true}}, S0),
    %% The founder is the seed leaf of their own pending group: establishing
    %% happens locally, without any self-add transition or DS round-trip.
    ?assertEqual(true, maps:get(established, S1)),
    ?assertEqual(0, maps:get(epoch, S1)),
    ?assertEqual([#{user_id => <<"1001">>, leaf_index => 0}], maps:get(roster, S1)),
    ?assertEqual(undefined, maps:get(transition, S1, undefined)),
    ?assertNot(has_rpc(A1, create_proposals)).

concurrent_joins_serialize_through_queue_test() ->
    S0 = (new_room_state(false, <<"42">>))#{
        version => 1,
        joined => #{<<"1001">> => <<"c1001">>, <<"1002">> => <<"c1002">>},
        key_packages => #{<<"1001">> => <<"KPA">>},
        pending_kps => #{<<"1002">> => <<"KPB">>},
        transition => #{
            id => 1,
            phase => awaiting_commit,
            ready_set => #{},
            target_users => [<<"1001">>],
            added_users => [],
            deadline_ms => 10000,
            initiated_by => undefined
        }
    },
    %% Second joiner validates while a transition is live -> queued, no new RPC.
    {S1, A1} = handle({validate_key_package_result, <<"1002">>, #{valid => true}}, S0),
    ?assertEqual([{add, <<"1002">>}], maps:get(add_queue, S1)),
    ?assertNot(has_rpc(A1, create_proposals)),
    %% Winning commit for the first transition completes -> queue drains into a
    %% fresh single-add transition for 1002.
    Parsed = #{new_epoch => 1, roster => [#{user_id => <<"1001">>, leaf_index => 0}],
               welcome_b64 => <<"W">>, commit_b64 => <<"C">>},
    {S2, A2} = handle({commit_parsed, ok, Parsed}, S1),
    ?assertEqual([], maps:get(add_queue, S2)),
    T2 = maps:get(transition, S2),
    ?assertEqual([<<"1002">>], maps:get(added_users, T2)),
    ?assert(lists:member(<<"1002">>, maps:get(target_users, T2))),
    ?assert(has_rpc(A2, create_proposals)),
    {Args2, _R2} = rpc_args(A2, create_proposals),
    ?assertEqual([<<"KPB">>], maps:get(add_b64, Args2)),
    ?assertEqual(1, maps:get(epoch, S2)).

proposals_relay_and_await_commit_test() ->
    S0 = founding_state(),
    {S1, A1} = handle({proposals_created, <<"PROP">>}, S0),
    T = maps:get(transition, S1),
    ?assertEqual(awaiting_commit, maps:get(phase, T)),
    ?assertEqual(<<"PROP">>, maps:get(proposals_b64, T)),
    PropSends = [U || {send_to_user, U, #{type := proposals}} <- A1],
    %% Existing members get the bundle; the welcomed user never sees its own add.
    ?assertEqual([<<"1001">>], PropSends),
    ?assertNot(lists:member(<<"1002">>, PropSends)).

commit_parsed_advances_epoch_test() ->
    S0 = awaiting_commit_state(),
    Parsed = #{
        new_epoch => 1,
        roster => [
            #{user_id => <<"1001">>, leaf_index => 0},
            #{user_id => <<"1002">>, leaf_index => 1}
        ],
        commit_b64 => <<"COMMIT">>,
        welcome_b64 => <<"WELCOME">>
    },
    {S1, A1} = handle({commit_parsed, ok, Parsed}, S0),
    ?assertEqual(1, maps:get(epoch, S1)),
    ?assertEqual(true, maps:get(established, S1)),
    ?assertEqual(undefined, maps:get(transition, S1)),
    %% Announce goes to the previous member applying the winning commit;
    %% welcome only to the newly added one.
    ?assertEqual(1, count_type(A1, announce_commit_transition)),
    ?assertEqual(1, count_type(A1, welcome)).

ready_counting_executes_when_all_ready_test() ->
    S0 = ready_targets_state(),
    %% One of two ready -> no execute yet.
    {S1, A1} = handle({ready_for_transition, <<"1001">>, 1}, S0),
    ?assertEqual(0, count_type(A1, execute_transition)),
    %% All targets ready -> execute.
    {S2, A2} = handle({ready_for_transition, <<"1002">>, 1}, S1),
    ?assertEqual(undefined, maps:get(transition, S2)),
    ?assertEqual(2, count_type(A2, execute_transition)).

timeout_forces_execute_test() ->
    S0 = ready_targets_state(),
    {S1, A1} = handle({transition_timeout, 1}, S0),
    ?assertEqual(undefined, maps:get(transition, S1)),
    ?assertEqual(2, count_type(A1, execute_transition)).

%% A transition whose DS proposals RPC never landed (still 'preparing') must
%% be cancelled by the timeout so the slot frees for the next queued op;
%% force-executing a proposal-less transition would wedge welcomed members.
timeout_in_preparing_phase_cancels_and_drains_test() ->
    S0 = (founding_state())#{
        add_queue => [{add, <<"1003">>}],
        key_packages => #{<<"1001">> => <<"KPA">>, <<"1002">> => <<"KPB">>, <<"1003">> => <<"KPC">>}
    },
    {S1, A1} = handle({transition_timeout, 1}, S0),
    %% The cancelling handle immediately drains the queued op into a fresh
    %% add transition, so there is no observable undefined-transition state
    %% here; assert the cancellation warning and the drained transition.
    ?assert(lists:any(
        fun({log_warning, {dave_transition_cancelled_no_proposals, 1}}) -> true; (_) -> false end,
        A1
    )),
    %% The queued add started immediately after the cancellation.
    T = maps:get(transition, S1),
    ?assertEqual([<<"1003">>], maps:get(added_users, T)),
    ?assert(has_rpc(A1, create_proposals)).

%% Every started transition arms its own timeout timer.
transitions_arm_timeout_timer_test() ->
    S0 = established_state(),
    {S1, _A1} = handle({join, <<"1003">>, 1, <<"c1003">>}, S0),
    {S2, _} = handle({key_package, <<"1003">>, <<"KPC">>}, S1),
    {_S3, A3} = handle({validate_key_package_result, <<"1003">>, #{valid => true}}, S2),
    ?assert(has_timer(A3, {transition_timeout, 1})).

%% RFC 9296: invalid commit/welcome recovery is targeted at the flagging
%% member only — their key material is dropped and their stale leaf scheduled
%% for removal. The rest of the room keeps its established group.
invalid_commit_welcome_targeted_removal_test() ->
    S0 = established_three_users(),
    {S1, A1} = handle({invalid_commit_welcome, <<"1003">>}, S0),
    ?assertEqual(true, maps:get(established, S1)),
    ?assertEqual(1, maps:get(epoch, S1)),
    ?assertNot(maps:is_key(<<"1003">>, maps:get(key_packages, S1))),
    ?assertEqual([2], maps:get(pending_removals, S1)),
    ?assert(has_timer(A1, flush_removals)),
    %% No room-wide reset was broadcast.
    ?assertEqual(0, count_type(A1, prepare_epoch)),
    %% The remaining members are untouched.
    ?assert(maps:is_key(<<"1001">>, maps:get(key_packages, S1))),
    ?assert(maps:is_key(<<"1002">>, maps:get(key_packages, S1))).

%% The flagger was the only roster member: the group is worthless; reset so
%% they can re-found.
invalid_commit_welcome_sole_roster_member_resets_test() ->
    S0 = (established_state())#{
        roster => [#{user_id => <<"1002">>, leaf_index => 1}]
    },
    {S1, A1} = handle({invalid_commit_welcome, <<"1002">>}, S0),
    ?assertEqual(false, maps:get(established, S1)),
    ?assertEqual(0, maps:get(epoch, S1)),
    ?assertEqual([], maps:get(roster, S1)),
    ?assertEqual(1, count_type(A1, prepare_epoch)),
    ?assertEqual(1, count_type(A1, prepare_transition)).

established_add_echoes_winning_commit_to_all_members_test() ->
    %% A/B live in an established room; C joins. The winning commit produced by
    %% A must be echoed back to A *and* B, not only to the add target C —
    %% clients apply the winning commit exclusively through this echo.
    S0 = established_two_users(),
    {SJ, _JA} = handle({join, <<"1003">>, 1, <<"c1003">>}, S0),
    {SK, _JK} = handle({key_package, <<"1003">>, <<"KPC">>}, SJ),
    {S1, _} = handle({validate_key_package_result, <<"1003">>, #{valid => true}}, SK),
    {S2, _} = handle({proposals_created, <<"PROP">>}, S1),
    {S3, _} = handle({commit_welcome, <<"1001">>, <<"CW">>}, S2),
    Parsed = #{
        new_epoch => 2,
        roster => [
            #{user_id => <<"1001">>, leaf_index => 0},
            #{user_id => <<"1002">>, leaf_index => 1},
            #{user_id => <<"1003">>, leaf_index => 2}
        ],
        commit_b64 => <<"COMMIT">>,
        welcome_b64 => <<"WELCOME">>
    },
    {S4, A4} = handle({commit_parsed, ok, Parsed}, S3),
    AnnouncedTo = lists:usort([
        U || {send_to_user, U, P} <- A4, maps:get(type, P) =:= announce_commit_transition
    ]),
    WelcomedTo = lists:usort([
        U || {send_to_user, U, P} <- A4, maps:get(type, P) =:= welcome
    ]),
    %% Previous members get the echo; the joiner gets a Welcome instead
    %% (processing its own add would collide with its pending join key).
    ?assertEqual([<<"1001">>, <<"1002">>], AnnouncedTo),
    ?assertEqual([<<"1003">>], WelcomedTo),
    ?assertEqual(2, maps:get(epoch, S4)).

%% --- rejoin / generation races -------------------------------------------

%% A disconnect belonging to an older connection generation must not evict
%% the member's fresh admission or key package (page reload racing the old
%% socket-death detection).
stale_member_left_ignored_after_rejoin_test() ->
    S0 = (established_two_users())#{
        joined => #{<<"1002">> => <<"c1002-new">>}
    },
    {S1, A1} = handle({member_left, <<"1002">>, <<"c1002-old">>}, S0),
    ?assertEqual(S0, S1),
    ?assert(lists:any(
        fun({log_warning, {dave_stale_member_left_ignored, _, _}}) -> true; (_) -> false end,
        A1
    )).

%% --- reported repro: admin joins, admin2 joins, admin leaves then REJOINS ------
%% When a member departs a two-person room, the remaining member must KEEP the
%% live group. Tearing it down (reset_to_unestablished) wipes the stayers' key
%% packages, so a subsequent rejoin of the departed user founds a brand-new
%% group that the stayer is never added back to -> two isolated MLS groups and
%% no audio either direction. The correct behaviour is to schedule the departed
%% leaf for removal (group survives) and let the rejoin flip the representation
%% atomically via a replace transition.
rejoin_after_peer_exit_joins_same_group_test() ->
    S0 = established_two_users(),
    %% 1001 (admin) leaves; 1002 (admin2) stays connected.
    {S1, _A1} = handle({member_left, <<"1001">>, <<"c1001">>}, S0),
    %% The group must NOT be destroyed while a member remains.
    ?assertEqual(true, maps:get(established, S1)),
    %% 1002's key package must survive so it can still be committed/welcome-d.
    ?assert(maps:is_key(<<"1002">>, maps:get(key_packages, S1))),
    %% 1001's own material is retired (they are gone until they rejoin).
    ?assertNot(maps:is_key(<<"1001">>, maps:get(joined, S1))),
    %% 1001 rejoins with a fresh connection generation.
    {S2, _A2} = handle({join, <<"1001">>, 1, <<"c1001b">>}, S1),
    {S3, _A3} = handle({key_package, <<"1001">>, <<"KPA2">>}, S2),
    {_S4, A4} = handle({validate_key_package_result, <<"1001">>, #{valid => true}}, S3),
    %% A single combined remove-old-leaf + add-new-KP transition fires.
    {Args, _} = rpc_args(A4, create_proposals),
    ?assertEqual([<<"KPA2">>], maps:get(add_b64, Args)),
    %% The old admin leaf (0) is removed in the same bundle.
    ?assertEqual([0], maps:get(remove_indices, Args)),
    %% The transition welcomes 1001 and its ready targets include the stayer 1002,
    %% proving both end up in ONE group rather than two isolated ones.
    T = maps:get(transition, _S4),
    ?assertEqual([<<"1001">>], maps:get(added_users, T)),
    ?assert(lists:member(<<"1002">>, maps:get(target_users, T))).

%% Fast rejoin while the previous incarnation is still rostered: the old key
%% package is retired immediately, the replacement intent recorded, and once
%% the fresh key package validates a single combined remove+add transition is
%% signed (RFC 9296 atomic representation flip).
fast_rejoin_replaces_stale_leaf_test() ->
    S0 = established_two_users(),
    {S1, A1} = handle({join, <<"1002">>, 1, <<"c1002-new">>}, S0),
    %% Old key material gone, admission updated, replacement intent recorded.
    ?assertNot(maps:is_key(<<"1002">>, maps:get(key_packages, S1))),
    ?assertEqual(<<"c1002-new">>, maps:get(<<"1002">>, maps:get(joined, S1))),
    ?assertEqual(1, maps:get(<<"1002">>, maps:get(replace_pending, S1))),
    %% Rejoiner got the ack + sender package like any joiner.
    ?assertEqual(1, count_type(A1, select_protocol_ack)),
    {S2, _} = handle({key_package, <<"1002">>, <<"KPB2">>}, S1),
    {S3, A3} = handle({validate_key_package_result, <<"1002">>, #{valid => true}}, S2),
    T = maps:get(transition, S3),
    ?assertEqual([<<"1002">>], maps:get(added_users, T)),
    {Args, _} = rpc_args(A3, create_proposals),
    ?assertEqual([<<"KPB2">>], maps:get(add_b64, Args)),
    ?assertEqual([1], maps:get(remove_indices, Args)),
    ?assert(has_timer(A3, {transition_timeout, maps:get(id, T)})),
    %% The replacement intent is consumed when the transition starts.
    ?assertNot(maps:is_key(<<"1002">>, maps:get(replace_pending, S3))).

%% The replace transition welcomes the rejoiner and echoes the commit to the
%% other members; the rejoiner must NOT receive the proposals bundle (it
%% contains their own add).
replace_transition_fanout_test() ->
    S0 = established_two_users(),
    {S1, _} = handle({join, <<"1002">>, 1, <<"c1002-new">>}, S0),
    {S2, _} = handle({key_package, <<"1002">>, <<"KPB2">>}, S1),
    {S3, _} = handle({validate_key_package_result, <<"1002">>, #{valid => true}}, S2),
    {S4, A4} = handle({proposals_created, <<"PROP">>}, S3),
    PropSends = [U || {send_to_user, U, #{type := proposals}} <- A4],
    ?assertEqual([<<"1001">>], PropSends),
    ?assertEqual(awaiting_commit, maps:get(phase, maps:get(transition, S4))),
    {S5, _A5} = handle({commit_welcome, <<"1001">>, <<"CW">>}, S4),
    Parsed = #{
        new_epoch => 2,
        roster => [
            #{user_id => <<"1001">>, leaf_index => 0},
            #{user_id => <<"1002">>, leaf_index => 1}
        ],
        commit_b64 => <<"COMMIT">>,
        welcome_b64 => <<"WELCOME">>
    },
    {_S6, A6} = handle({commit_parsed, ok, Parsed}, S5),
    AnnouncedTo = lists:usort([
        U || {send_to_user, U, P} <- A6, maps:get(type, P) =:= announce_commit_transition
    ]),
    WelcomedTo = lists:usort([
        U || {send_to_user, U, P} <- A6, maps:get(type, P) =:= welcome
    ]),
    ?assertEqual([<<"1001">>], AnnouncedTo),
    ?assertEqual([<<"1002">>], WelcomedTo).

%% If a plain removal beat the queued replacement to the roster (the stale
%% leaf is already gone), the queued replace op degrades to a plain add.
queued_replace_degrades_to_add_when_leaf_gone_test() ->
    S0 = (established_two_users())#{
        transition => #{
            id => 5,
            phase => awaiting_commit,
            ready_set => #{},
            target_users => [<<"1001">>],
            added_users => [],
            deadline_ms => 10000,
            proposals_b64 => <<"P">>,
            initiated_by => <<"1001">>
        },
        add_queue => [{replace, <<"1002">>, 1}]
    },
    %% The winning commit removed 1002 entirely.
    Parsed = #{
        new_epoch => 3,
        roster => [#{user_id => <<"1001">>, leaf_index => 0}],
        welcome_b64 => undefined,
        commit_b64 => <<"C">>
    },
    {S1, A1} = handle({commit_parsed, ok, Parsed}, S0),
    ?assertEqual([], maps:get(add_queue, S1)),
    T = maps:get(transition, S1),
    ?assertEqual([<<"1002">>], maps:get(added_users, T)),
    {Args, _} = rpc_args(A1, create_proposals),
    ?assertEqual([<<"KPB">>], maps:get(add_b64, Args)),
    ?assertEqual([], maps:get(remove_indices, Args)).

%% A removal flush landing while another transition is live must NOT clobber
%% the active transition; the window is re-armed instead.
flush_removals_defers_during_active_transition_test() ->
    S0 = (established_three_users())#{
        pending_removals => [2],
        transition => #{
            id => 7,
            phase => awaiting_commit,
            ready_set => #{},
            target_users => [<<"1001">>, <<"1002">>],
            added_users => [],
            deadline_ms => 10000,
            proposals_b64 => <<"P">>,
            initiated_by => <<"1001">>
        }
    },
    {S1, A1} = handle(flush_removals, S0),
    ?assertEqual(7, maps:get(id, maps:get(transition, S1))),
    ?assertEqual([2], maps:get(pending_removals, S1)),
    ?assert(has_timer(A1, flush_removals)),
    ?assertNot(has_rpc(A1, create_proposals)).

bad_key_package_dropped_test() ->
    S0 = (new_room_state(true, <<"42">>))#{pending_kps => #{<<"1001">> => <<"KP">>}},
    {S1, A1} = handle({validate_key_package_result, <<"1001">>, #{valid => false, reason => <<"bad">>}}, S0),
    ?assertEqual(#{}, maps:get(pending_kps, S1)),
    ?assert(lists:any(fun({log_warning, _}) -> true; (_) -> false end, A1)).

unvalidated_key_package_is_never_signed_into_adds_test() ->
    %% A key package must pass the DS validation round-trip before any add
    %% proposal referencing it can be created.
    S0 = established_state(),
    {S1, A1} = handle({key_package, <<"1001">>, <<"EVIL">>}, S0),
    ?assert(has_rpc(A1, validate_key_package)),
    ?assertNot(has_rpc(A1, create_proposals)),
    ?assertEqual(maps:get(key_packages, S0), maps:get(key_packages, S1)),
    {S2, A2} = handle({validate_key_package_result, <<"1001">>, #{valid => false, reason => <<"nope">>}}, S1),
    ?assertEqual(#{}, maps:get(pending_kps, S2)),
    ?assertNot(has_rpc(A2, create_proposals)).


unauthorized_client_events_are_dropped_test() ->
    %% A user who never went through the join/negotiation path must not be able
    %% to drive the room: key packages, commits, readiness and invalid-commit
    %% reports all get dropped with a warning instead of mutating state.
    S0 = established_state(),
    {S1, A1} = handle({key_package, <<"9999">>, <<"KPX">>}, S0),
    ?assertEqual(S0, S1),
    ?assert(lists:any(
        fun({log_warning, {dave_unauthorized_sender, key_package, <<"9999">>}}) -> true; (_) -> false end,
        A1
    )),
    {S2, _A2} = handle({commit_welcome, <<"9999">>, <<"CW">>}, S0),
    ?assertEqual(S0, S2),
    {S3, _A3} = handle({invalid_commit_welcome, <<"9999">>}, S0),
    ?assertEqual(S0, S3),
    {S4, _A4} = handle({ready_for_transition, <<"9999">>, 1}, S0),
    ?assertEqual(S0, S4).

lower_version_joiner_triggers_fallback_refoundation_test() ->
    %% An established v2 room with a v1-only joiner must fall back per RFC 9296:
    %% tear the group down, re-found at the new common floor, and keep the
    %% joiner's admission so their key package is accepted.
    S0 = (established_two_users())#{version => 2},
    {S1, A1} = handle({join, <<"1003">>, 1, <<"c1003">>}, S0),
    ?assertEqual(1, maps:get(version, S1)),
    ?assertEqual(false, maps:get(established, S1)),
    ?assertEqual(0, maps:get(epoch, S1)),
    ?assertEqual([], maps:get(roster, S1)),
    Reinit = lists:sort([
        U || {send_to_user, U, P} <- A1, maps:get(type, P) =:= prepare_epoch
    ]),
    ?assertEqual([<<"1001">>, <<"1002">>], Reinit),
    ?assertEqual(1, count_type(A1, select_protocol_ack)),
    ?assert(has_rpc(A1, sender_package)),
    %% The joiner is admitted: their key package enters the validation queue.
    {S2, A2} = handle({key_package, <<"1003">>, <<"KPC">>}, S1),
    ?assert(has_rpc(A2, validate_key_package)),
    ?assert(maps:is_key(<<"1003">>, maps:get(pending_kps, S2))).

member_left_retires_admission_and_key_package_test() ->
    S0 = established_three_users(),
    {S1, _A1} = handle({member_left, <<"1003">>, <<"c1003">>}, S0),
    ?assertNot(maps:is_key(<<"1003">>, maps:get(joined, S1))),
    ?assertNot(maps:is_key(<<"1003">>, maps:get(key_packages, S1))),
    %% And afterwards they cannot drive the room anymore.
    {S2, A2} = handle({key_package, <<"1003">>, <<"KPC2">>}, S1),
    ?assertEqual(S1, S2),
    ?assert(lists:any(
        fun({log_warning, {dave_unauthorized_sender, key_package, <<"1003">>}}) -> true; (_) -> false end,
        A2
    )).

%% --- test fixtures -------------------------------------------------------

founding_state() ->
    (new_room_state(true, <<"42">>))#{
        version => 1,
        joined => #{<<"1001">> => <<"c1001">>, <<"1002">> => <<"c1002">>},
        key_packages => #{<<"1001">> => <<"KPA">>, <<"1002">> => <<"KPB">>},
        roster => [#{user_id => <<"1001">>, leaf_index => 0}],
        transition => #{
            id => 1,
            phase => preparing,
            ready_set => #{},
            target_users => [<<"1001">>, <<"1002">>],
            added_users => [<<"1002">>],
            deadline_ms => 10000,
            initiated_by => undefined
        }
    }.

awaiting_commit_state() ->
    S = founding_state(),
    T = maps:get(transition, S),
    %% Model that user 1001 produced the winning commit.
    S#{transition => T#{phase => awaiting_commit, proposals_b64 => <<"PROP">>, initiated_by => <<"1001">>}}.

ready_targets_state() ->
    awaiting_commit_state().

established_state() ->
    (new_room_state(true, <<"42">>))#{
        version => 1,
        epoch => 1,
        joined => #{<<"1001">> => <<"c1001">>, <<"1002">> => <<"c1002">>},
        key_packages => #{<<"1001">> => <<"KPA">>, <<"1002">> => <<"KPB">>},
        roster => [
            #{user_id => <<"1001">>, leaf_index => 0},
            #{user_id => <<"1002">>, leaf_index => 1}
        ]
    }.

established_two_users() ->
    established_state().

established_three_users() ->
    S = established_state(),
    S#{
        joined => maps:put(<<"1003">>, <<"c1003">>, maps:get(joined, S)),
        key_packages => maps:put(<<"1003">>, <<"KPC">>, maps:get(key_packages, S)),
        roster => maps:get(roster, S) ++ [#{user_id => <<"1003">>, leaf_index => 2}]
    }.

%% A duplicate key-package validation racing an active add transition queued
%% the same user twice; once the first transition lands them in the roster the
%% stale queue head must be dropped instead of producing a second Add
%% (libdave: 'Duplicate encryption key').
stale_queued_add_skipped_when_already_member_test() ->
    S0 = (new_room_state(false, <<"42">>))#{
        version => 1,
        established => true,
        epoch => 0,
        joined => #{<<"1001">> => <<"c1001">>, <<"1002">> => <<"c1002">>},
        key_packages => #{<<"1001">> => <<"KPA">>, <<"1002">> => <<"KPB">>},
        roster => [#{user_id => <<"1001">>, leaf_index => 0}],
        add_queue => [{add, <<"1002">>}],
        transition => #{
            id => 2,
            phase => awaiting_commit,
            ready_set => #{},
            target_users => [<<"1002">>],
            added_users => [<<"1002">>],
            deadline_ms => 10000,
            initiated_by => undefined
        }
    },
    Parsed = #{
        new_epoch => 1,
        roster => [
            #{user_id => <<"1001">>, leaf_index => 0},
            #{user_id => <<"1002">>, leaf_index => 1}
        ],
        welcome_b64 => <<"W">>,
        commit_b64 => <<"C">>
    },
    {S2, A2} = handle({commit_parsed, ok, Parsed}, S0),
    ?assertEqual([], maps:get(add_queue, S2)),
    ?assertEqual(undefined, maps:get(transition, S2, undefined)),
    ?assertNot(has_rpc(A2, create_proposals)).

%% A late re-validation of a key package for a user who is already a live
%% member must not start or queue any add either.
revalidation_of_existing_member_does_not_readd_test() ->
    S0 = (new_room_state(false, <<"42">>))#{
        version => 1,
        established => true,
        epoch => 1,
        joined => #{<<"1001">> => <<"c1001">>, <<"1002">> => <<"c1002">>},
        roster => [
            #{user_id => <<"1001">>, leaf_index => 0},
            #{user_id => <<"1002">>, leaf_index => 1}
        ],
        key_packages => #{<<"1001">> => <<"KPA">>},
        pending_kps => #{<<"1002">> => <<"KPB2">>},
        transition => undefined
    },
    {S1, A1} = handle({validate_key_package_result, <<"1002">>, #{valid => true}}, S0),
    %% The KP promotion still happens (cache refresh) but no add fires.
    ?assertEqual(<<"KPB2">>, maps:get(<<"1002">>, maps:get(key_packages, S1))),
    ?assertEqual([], maps:get(add_queue, S1)),
    ?assertEqual(undefined, maps:get(transition, S1, undefined)),
    ?assertNot(has_rpc(A1, create_proposals)).

-endif.
