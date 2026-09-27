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
%%   joined        :: #{UserId => true}  clients admitted via the join/negotiation path
%%   roster        :: [#{user_id, leaf_index}]  last-known post-commit roster
%%   transition    :: undefined | transition()
%%   pending_removals :: [LeafIndex]     batched removal targets awaiting flush
%%   add_queue     :: [UserId]           validated joins waiting their turn; a
%%                                     libdave proposals bundle carries exactly
%%                                     one Add, so joins are serialized
%%
%% A transition() is:
%%   #{id, phase, ready_set, deadline_ms, proposals_b64, initiated_by}
%%   phase: preparing | executing | awaiting_commit
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
-type roster_entry() :: #{user_id => user_id(), leaf_index => non_neg_integer()}.
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
    deadline_ms := pos_integer(),
    proposals_b64 => binary(),
    initiated_by => user_id() | undefined
}.

-type room_state() :: #{
    version => non_neg_integer(),
    established => boolean(),
    epoch => non_neg_integer(),
    key_packages => #{user_id() => binary()},
    pending_kps => #{user_id() => binary()},
    joined => #{user_id() => true},
    roster := [roster_entry()],
    transition => undefined | transition(),
    pending_removals => [non_neg_integer()],
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
        add_queue => [],
        next_transition_id => 1
    }.

%% --------------------------------------------------------------------------
%% Join / version negotiation
%% --------------------------------------------------------------------------

handle({join, UserId, MaxVersion}, State) when is_binary(UserId), is_integer(MaxVersion) ->
    %% Record the admission. Opcode-17 client events are only honored for users
    %% in this set; the join/move/token flows run their real permission checks
    %% *before* driving {join, _, _} with the authenticated session user, so
    %% membership here is itself the authorization proof.
    Joined0 = maps:get(joined, State, #{}),
    StateJ = State#{joined => Joined0#{UserId => true}},
    ExistingVersion = maps:get(version, StateJ, 0),
    Established = maps:get(established, StateJ, false),
    case Established andalso ExistingVersion > 0 andalso MaxVersion < ExistingVersion of
        true ->
            %% A live MLS group is bound to its negotiated protocol version; a
            %% member whose maximum sits below it cannot join that key schedule.
            %% Per RFC 9296 the delivery service falls back: discard the group
            %% and re-found at the new common floor instead of silently
            %% corrupting the version under a live group.
            Members = lists:usort(all_present_users(StateJ) ++ [UserId]),
            State1 = StateJ#{
                version => MaxVersion,
                established => false,
                epoch => 0,
                transition => undefined,
                key_packages => #{},
                roster => [],
                pending_removals => [],
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
            State1 = StateJ#{version => Negotiated},
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
            %% Every key-package holder must receive the proposals bundle for
            %% this transition — including the joiner being added, whose own
            %% add they will commit. Fan out here from the *live* state: the
            %% old driver-level MemberProvider closure captured the pre-event
            %% room snapshot, so founding transitions created during a user's
            %% own KP validation delivered proposals to nobody and the room
            %% hung in awaiting_commit forever.
            Payload = #{
                type => proposals,
                transition_id => maps:get(id, T),
                data => ProposalsB64
            },
            Targets = maps:keys(maps:get(key_packages, State, #{})),
            Sends = [{send_to_user, U, Payload} || U <- Targets],
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
    TargetUsers = target_users_for(T),
    EchoUsers = lists:usort(all_present_users(State) ++ TargetUsers),
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
                Adds = added_users(Roster, maps:get(roster, State, [])) -- [Committer],
                [
                    {send_to_user, U, #{
                        type => welcome,
                        transition_id => trans_id(T),
                        data => WelcomeB64
                    }}
                 || U <- Adds
                ]
        end,
    State1 = State#{
        epoch => NewEpoch,
        established => true,
        roster => Roster,
        transition => undefined
    },
    drain_next_add(State1, Announce ++ Welcomes);

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
                            drain_next_add(SE, AE);
                        false ->
                            {State#{transition => T1}, []}
                    end;
                _ ->
                    {State, []}
            end
    end;

%% Deadline elapsed (host timer fired) — force-execute if we still have a live
%% preparing/awaiting transition.
handle({transition_timeout, TransitionId}, State) ->
    case maps:get(transition, State, undefined) of
        _T = #{id := TransitionId} ->
            {SE, AE} = execute_transition(State),
            drain_next_add(SE, AE);
        _ ->
            {State, []}
    end;

%% --------------------------------------------------------------------------
%% Invalid commit/welcome from any member -> discard current transition and
%% restart with prepare_epoch(1); everyone resubmits key packages.
%% --------------------------------------------------------------------------
handle({invalid_commit_welcome, UserId}, State) ->
    case is_admitted(UserId, State) of
        false ->
            {State, [{log_warning, {dave_unauthorized_sender, invalid_commit_welcome, UserId}}]};
        true ->
            Members = all_present_users(State),
            State1 = State#{
                established => false,
                %% The wire epoch `1' below signals "found a brand-new group"; that
                %% group starts at MLS epoch 0, so the internal counter must be 0
                %% as well — otherwise the next round of external proposals gets
                %% signed for epoch 1, every client rejects the epoch binding, and
                %% the room can never re-found itself.
                epoch => 0,
                transition => undefined,
                key_packages => #{},
                pending_kps => #{},
                roster => [],
                pending_removals => [],
                add_queue => []
            },
            Actions = [
                {send_to_user, U, #{type => prepare_epoch, epoch => 1, version => maps:get(version, State, 0)}}
             || U <- Members
            ],
            {State1, Actions}
    end;

%% --------------------------------------------------------------------------
%% Sole-member reset: only one member remains -> prepare_epoch(1) + prepare(0).
%% --------------------------------------------------------------------------
handle({member_left, UserId}, State) ->
    %% Retire the departed user's admission and key package right away: ghosts
    %% in `joined' would keep passing the authorization gate, and ghosts in
    %% `key_packages' would count as present for future founding rounds and
    %% echo broadcasts.
    StateR = State#{
        joined => maps:remove(UserId, maps:get(joined, State, #{})),
        key_packages => maps:remove(UserId, maps:get(key_packages, State, #{})),
        pending_kps => maps:remove(UserId, maps:get(pending_kps, State, #{})),
        add_queue => lists:delete(UserId, maps:get(add_queue, State, []))
    },
    Members = all_present_users(StateR),
    Remaining = Members -- [UserId],
    case length(Remaining) =< 1 andalso maps:get(established, StateR, false) of
        true ->
            State1 = reset_to_unestablished(StateR),
            Actions =
                case Remaining of
                    [Only] ->
                        [
                            {send_to_user, Only, #{
                                type => prepare_epoch,
                                epoch => 1,
                                version => maps:get(version, StateR, 0)
                            }},
                            {send_to_user, Only, #{
                                type => prepare_transition,
                                transition_id => ?K_INIT_TRANSITION_ID,
                                version => maps:get(version, StateR, 0)
                            }}
                        ];
                    [] ->
                        []
                end,
            {State1, Actions};
        false ->
            %% Not the sole-member case: schedule a removal of the departed leaf.
            schedule_removal(UserId, StateR)
    end;

%% Flush the batched removal window -> create the remove proposals.
handle(flush_removals, State) ->
    case maps:get(pending_removals, State, []) of
        [] ->
            {State, []};
        Indices ->
            State1 = State#{pending_removals => []},
            start_remove_transition(State1, Indices)
    end;

%% A validate-key-package result reported back by the host. Validation success
%% promotes the parked package into the live set and drives founding / member-add.
handle({validate_key_package_result, UserId, #{valid := true}}, State) ->
    Pending = maps:get(pending_kps, State, #{}),
    case maps:take(UserId, Pending) of
        {KpB64, Pending1} ->
            Kps = maps:get(key_packages, State, #{}),
            State1 = State#{pending_kps => Pending1, key_packages => Kps#{UserId => KpB64}},
            %% One Add per bundle: every join is its own transition, gated
            %% behind whatever transition is currently active.
            maybe_start_add(State1, [UserId]);
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

%% Gate: only one MLS transition may be live at a time. Extra targets wait in
%% `add_queue' (arrival order, deduplicated) and are released one per completed
%% transition by drain_next_add/2.
-spec maybe_start_add(room_state(), [user_id()]) -> {room_state(), [action()]}.
maybe_start_add(State, Targets) ->
    case maps:get(transition, State, undefined) of
        undefined ->
            start_add_transition(State, Targets);
        _Active ->
            Queue0 = maps:get(add_queue, State, []),
            Queue1 = Queue0 ++ [U || U <- Targets, not lists:member(U, Queue0)],
            {State#{add_queue => Queue1}, []}
    end.

%% Release exactly one queued add (the caller just freed the transition slot).
%% Releasing more than one eagerly would sign overlapping proposals for the same
%% epoch before the previous transition's welcome has been delivered.
-spec drain_next_add(room_state(), [action()]) -> {room_state(), [action()]}.
drain_next_add(State, Actions) ->
    case maps:get(add_queue, State, []) of
        [] ->
            {State, Actions};
        [Next | Rest] ->
            {S1, A1} = start_add_transition(State#{add_queue => Rest}, [Next]),
            {S1, Actions ++ A1}
    end.

-spec start_add_transition(room_state(), [user_id()]) -> {room_state(), [action()]}.
start_add_transition(State, TargetUsers) ->
    Id = next_trans_id(State),
    Epoch = maps:get(epoch, State, 0),
    AddB64 = [maps:get(U, maps:get(key_packages, State, #{}), <<>>) || U <- TargetUsers],
    T = #{
        id => Id,
        phase => preparing,
        ready_set => #{},
        target_users => TargetUsers,
        deadline_ms => ?K_DEFAULT_TRANSITION_DURATION_MS,
        initiated_by => undefined
    },
    State1 = State#{transition => T, next_transition_id => Id + 1},
    %% Ask the DS to sign add proposals for the targets.
    {State1, [
        {dave_rpc, create_proposals, #{
            group_id => maps:get(group_id, State, <<>>),
            epoch => Epoch,
            add_b64 => AddB64,
            remove_indices => []
        }, make_ref()}
    ]}.

-spec start_remove_transition(room_state(), [non_neg_integer()]) -> {room_state(), [action()]}.
start_remove_transition(State, RemoveIndices) ->
    Id = next_trans_id(State),
    Epoch = maps:get(epoch, State, 0),
    RemainingTargets = [U || #{user_id := U} <- maps:get(roster, State, [])],
    T = #{
        id => Id,
        phase => preparing,
        ready_set => #{},
        target_users => RemainingTargets,
        deadline_ms => ?K_DEFAULT_TRANSITION_DURATION_MS,
        initiated_by => undefined
    },
    {State#{transition => T}, [
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
            Pending = maps:get(pending_removals, State, []),
            WasEmpty = Pending =:= [],
            State1 = State#{pending_removals => Pending ++ [LeafIndex]},
            Actions =
                case WasEmpty of
                    true -> [{schedule_timer, flush_removals, ?K_REMOVE_BATCH_WINDOW_MS}];
                    false -> []
                end,
            {State1, Actions}
    end.

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
        pending_removals => []
    }.

all_present_users(State) ->
    %% Users with a key package are the connected set for protocol purposes.
    maps:keys(maps:get(key_packages, State, #{})).

%% Users admitted through the owning process' join/negotiation path. Client
%% originated opcode-17 events are only honored for members of this set.
-spec is_admitted(user_id(), room_state()) -> boolean().
is_admitted(UserId, State) ->
    maps:is_key(UserId, maps:get(joined, State, #{})).

added_users(NewRoster, OldRoster) ->
    OldIds = [U || #{user_id := U} <- OldRoster],
    [U || #{user_id := U} <- NewRoster, not lists:member(U, OldIds)].

find_leaf(UserId, Roster) ->
    case [LI || #{user_id := U, leaf_index := LI} <- Roster, U =:= UserId] of
        [LI | _] -> LI;
        [] -> undefined
    end.

trans_id(undefined) -> ?K_INIT_TRANSITION_ID;
trans_id(T) -> maps:get(id, T, ?K_INIT_TRANSITION_ID).

initiated_by(undefined) -> undefined;
initiated_by(T) -> maps:get(initiated_by, T, undefined).

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

negotiation_test() ->
    S0 = new_room_state(false, <<"42">>),
    %% New room adopts the joiner's max version and requests the sender package.
    {S1, A1} = handle({join, <<"1001">>, 1}, S0),
    ?assertEqual(1, maps:get(version, S1)),
    ?assert(has_rpc(A1, sender_package)),
    [Ack] = find_send(A1, <<"1001">>),
    ?assertEqual(select_protocol_ack, maps:get(type, Ack)),
    ?assertEqual(1, maps:get(version, Ack)),
    %% Second joiner with lower max lowers the negotiated version.
    {_S2, A2} = handle({join, <<"1002">>, 0}, S1),
    [Ack2] = find_send(A2, <<"1002">>),
    ?assertEqual(0, maps:get(version, Ack2)).

passthrough_no_sender_package_test() ->
    S0 = new_room_state(false, <<"42">>),
    {S1, A1} = handle({join, <<"1001">>, 0}, S0),
    ?assertEqual(0, maps:get(version, S1)),
    ?assertNot(has_rpc(A1, sender_package)),
    ?assertEqual(1, length(A1)).

founding_from_first_key_package_test() ->
    S0 = (new_room_state(false, <<"42">>))#{
        version => 1,
        joined => #{<<"1001">> => true, <<"1002">> => true},
        key_packages => #{<<"1001">> => <<"KPA">>},
        pending_kps => #{<<"1002">> => <<"KPB">>}
    },
    {S1, A1} = handle({validate_key_package_result, <<"1002">>, #{valid => true}}, S0),
    %% One Add per bundle: the just-validated user gets a single-target
    %% transition; co-present users are picked up by their own validation events.
    T = maps:get(transition, S1),
    ?assertEqual(preparing, maps:get(phase, T)),
    ?assertEqual([<<"1002">>], maps:get(target_users, T)),
    ?assert(has_rpc(A1, create_proposals)),
    {Args, _Ref} = rpc_args(A1, create_proposals),
    ?assertEqual([<<"KPB">>], maps:get(add_b64, Args)),
    ?assertEqual([], maps:get(remove_indices, Args)).

concurrent_joins_serialize_through_queue_test() ->
    S0 = (new_room_state(false, <<"42">>))#{
        version => 1,
        joined => #{<<"1001">> => true, <<"1002">> => true},
        key_packages => #{<<"1001">> => <<"KPA">>},
        pending_kps => #{<<"1002">> => <<"KPB">>},
        transition => #{
            id => 1,
            phase => awaiting_commit,
            ready_set => #{},
            target_users => [<<"1001">>],
            deadline_ms => 10000,
            initiated_by => undefined
        }
    },
    %% Second joiner validates while a transition is live -> queued, no new RPC.
    {S1, A1} = handle({validate_key_package_result, <<"1002">>, #{valid => true}}, S0),
    ?assertEqual([<<"1002">>], maps:get(add_queue, S1)),
    ?assertNot(has_rpc(A1, create_proposals)),
    %% Winning commit for the first transition completes -> queue drains into a
    %% fresh single-add transition for 1002.
    Parsed = #{new_epoch => 1, roster => [#{user_id => <<"1001">>, leaf_index => 0}],
               welcome_b64 => <<"W">>, commit_b64 => <<"C">>},
    {S2, A2} = handle({commit_parsed, ok, Parsed}, S1),
    ?assertEqual([], maps:get(add_queue, S2)),
    T2 = maps:get(transition, S2),
    ?assertEqual([<<"1002">>], maps:get(target_users, T2)),
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
    ?assert(lists:any(fun({send_to_user, _, #{type := proposals}}) -> true; (_) -> false end, A1)).

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
    %% Announce goes to both members; welcome only to the newly added one.
    ?assertEqual(2, count_type(A1, announce_commit_transition)),
    ?assertEqual(1, count_type(A1, welcome)).

ready_counting_executes_when_all_ready_test() ->
    S0 = ready_targets_state(),
    %% One of two ready -> no execute yet.
    {S1, A1} = handle({ready_for_transition, <<"1001">>, 1}, S0),
    ?assertEqual(0, count_type(A1, execute_transition)),
    %% Both ready -> execute.
    {S2, A2} = handle({ready_for_transition, <<"1002">>, 1}, S1),
    ?assertEqual(undefined, maps:get(transition, S2)),
    ?assertEqual(2, count_type(A2, execute_transition)).

timeout_forces_execute_test() ->
    S0 = ready_targets_state(),
    {S1, A1} = handle({transition_timeout, 1}, S0),
    ?assertEqual(undefined, maps:get(transition, S1)),
    ?assertEqual(2, count_type(A1, execute_transition)).

invalid_commit_welcome_reinitializes_test() ->
    S0 = established_state(),
    {S1, A1} = handle({invalid_commit_welcome, <<"1002">>}, S0),
    ?assertEqual(false, maps:get(established, S1)),
    %% The internal MLS epoch must be 0 after a reset: the wire prepare_epoch(1)
    %% means "found a brand-new group", and a fresh MLS group starts at epoch 0.
    %% Signing the next external proposals at any other epoch strands the room
    %% (every client rejects the epoch binding).
    ?assertEqual(0, maps:get(epoch, S1)),
    ?assertEqual([], maps:get(roster, S1)),
    ?assertEqual([], maps:get(pending_removals, S1)),
    ?assert(count_type(A1, prepare_epoch) >= 1).

established_add_echoes_winning_commit_to_all_members_test() ->
    %% A/B live in an established room; C joins. The winning commit produced by
    %% A must be echoed back to A *and* B, not only to the add target C —
    %% clients apply the winning commit exclusively through this echo.
    S0 = established_two_users(),
    {SJ, _JA} = handle({join, <<"1003">>, 1}, S0),
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
    ?assertEqual([<<"1001">>, <<"1002">>, <<"1003">>], AnnouncedTo),
    ?assertEqual([<<"1003">>], WelcomedTo),
    ?assertEqual(2, maps:get(epoch, S4)).

reset_then_key_package_refounds_at_mls_epoch_zero_test() ->
    S0 = established_state(),
    {S1, _} = handle({invalid_commit_welcome, <<"1002">>}, S0),
    {S2, A2} = handle({key_package, <<"1001">>, <<"KP2">>}, S1),
    ?assert(has_rpc(A2, validate_key_package)),
    {_S3, A3} = handle({validate_key_package_result, <<"1001">>, #{valid => true}}, S2),
    ?assert(has_rpc(A3, create_proposals)),
    {Args, _} = rpc_args(A3, create_proposals),
    ?assertEqual(0, maps:get(epoch, Args)).

sole_member_reset_test() ->
    S0 = established_two_users(),
    {S1, A1} = handle({member_left, <<"1002">>}, S0),
    ?assertEqual(false, maps:get(established, S1)),
    ?assertEqual(1, count_type(A1, prepare_epoch)),
    ?assertEqual(1, count_type(A1, prepare_transition)).

non_sole_leave_batches_removal_test() ->
    S0 = established_three_users(),
    {S1, A1} = handle({member_left, <<"1003">>}, S0),
    ?assertEqual([2], maps:get(pending_removals, S1)),
    ?assert(lists:any(fun({schedule_timer, flush_removals, _}) -> true; (_) -> false end, A1)),
    %% Flushing issues the remove proposals.
    {_S2, A2} = handle(flush_removals, S1),
    ?assert(has_rpc(A2, create_proposals)),
    {Args, _} = rpc_args(A2, create_proposals),
    ?assertEqual([2], maps:get(remove_indices, Args)),
    ?assertEqual([], maps:get(add_b64, Args)).

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
    {S1, A1} = handle({join, <<"1003">>, 1}, S0),
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
    {S1, _A1} = handle({member_left, <<"1003">>}, S0),
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
    (new_room_state(false, <<"42">>))#{
        version => 1,
        joined => #{<<"1001">> => true, <<"1002">> => true},
        key_packages => #{<<"1001">> => <<"KPA">>, <<"1002">> => <<"KPB">>},
        transition => #{
            id => 1,
            phase => preparing,
            ready_set => #{},
            target_users => [<<"1001">>, <<"1002">>],
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
        joined => #{<<"1001">> => true, <<"1002">> => true},
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
        joined => maps:put(<<"1003">>, true, maps:get(joined, S)),
        key_packages => maps:put(<<"1003">>, <<"KPC">>, maps:get(key_packages, S)),
        roster => maps:get(roster, S) ++ [#{user_id => <<"1003">>, leaf_index => 2}]
    }.

-endif.
