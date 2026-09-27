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
%%   roster        :: [#{user_id, leaf_index}]  last-known post-commit roster
%%   transition    :: undefined | transition()
%%   pending_removals :: [LeafIndex]     batched removal targets awaiting flush
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
    new_room_state/1,
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
    | {broadcast_channel, map()}
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
    roster := [roster_entry()],
    transition => undefined | transition(),
    pending_removals => [non_neg_integer()],
    next_transition_id => non_neg_integer()
}.

%% @doc Fresh room state. `Established' reflects whether the channel already has
%% an active MLS group (from persistence); callers start with `false'.
-spec new_room_state(boolean()) -> room_state().
new_room_state(Established) ->
    #{
        version => 0,
        established => Established,
        epoch => 0,
        key_packages => #{},
        roster => [],
        transition => undefined,
        pending_removals => [],
        next_transition_id => 1
    }.

%% --------------------------------------------------------------------------
%% Join / version negotiation
%% --------------------------------------------------------------------------

handle({join, UserId, MaxVersion}, State) when is_binary(UserId), is_integer(MaxVersion) ->
    %% Choose the highest version supported by every e2ee-required participant.
    %% For a new (unestablished) room the joiner's own max becomes the floor.
    ExistingVersion = maps:get(version, State, 0),
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
    Kps = maps:get(key_packages, State, #{}),
    State1 = State#{key_packages => Kps#{UserId => KpB64}},
    Established = maps:get(established, State1, false),
    case Established of
        false ->
            %% Founding trigger: first key package starts the group with everyone
            %% currently present whose key package we hold.
            start_add_transition(State1, all_present_users(State1));
        true ->
            %% Already established: add this single user.
            start_add_transition(State1, [UserId])
    end;

%% --------------------------------------------------------------------------
%% Proposal bundle created by the delivery service.
%% --------------------------------------------------------------------------
handle({proposals_created, ProposalsB64}, State) ->
    case maps:get(transition, State, undefined) of
        undefined ->
            {State, []};
        T = #{phase := preparing} ->
            TargetUsers = maps:get(target_users, T, []),
            %% Relay the signed external proposals to every target so each can
            %% build a commit candidate.
            Broadcast = {broadcast_channel, #{
                type => proposals,
                transition_id => maps:get(id, T),
                data => ProposalsB64
            }},
            Sends = [
                {send_to_user, U, #{
                    type => proposals,
                    transition_id => maps:get(id, T),
                    data => ProposalsB64
                }}
             || U <- TargetUsers
            ],
            Actions = [Broadcast | Sends],
            T1 = T#{proposals_b64 => ProposalsB64, phase => awaiting_commit},
            {State#{transition => T1}, Actions}
    end;

%% --------------------------------------------------------------------------
%% A committing client returned its commit/welcome bundle; ask the DS to parse it.
%% The parse result arrives via {commit_parsed, ...}.
%% --------------------------------------------------------------------------
handle({commit_welcome, CommitterId, BundleB64}, State) ->
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
    end;

%% First valid parsed commit wins the epoch.
handle({commit_parsed, ok, Parsed}, State) ->
    T = maps:get(transition, State, undefined),
    NewEpoch = maps:get(new_epoch, Parsed, maps:get(epoch, State, 0) + 1),
    Roster = maps:get(roster, Parsed, maps:get(roster, State, [])),
    WelcomeB64 = maps:get(welcome_b64, Parsed, undefined),
    CommitB64 = maps:get(commit_b64, Parsed, <<>>),
    %% Announce the winning commit transition to all members; welcome only to adds.
    TargetUsers = target_users_for(T),
    Announce = [
        {send_to_user, U, #{
            type => announce_commit_transition,
            transition_id => trans_id(T),
            data => CommitB64
        }}
     || U <- TargetUsers
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
    {State1, Announce ++ Welcomes};

handle({commit_parsed, error, _Reason}, State) ->
    %% Losing/invalid commit; leave current transition intact so another may win.
    {State, []};

%% --------------------------------------------------------------------------
%% Transition readiness counting.
%% --------------------------------------------------------------------------
handle({ready_for_transition, UserId, TransitionId}, State) ->
    case maps:get(transition, State, undefined) of
        T = #{id := TransitionId, ready_set := Ready} ->
            Ready1 = Ready#{UserId => true},
            TargetUsers = target_users_for(T),
            AllReady = lists:all(fun(U) -> maps:is_key(U, Ready1) end, TargetUsers),
            T1 = T#{ready_set => Ready1},
            case AllReady of
                true ->
                    execute_transition(State#{transition => T1});
                false ->
                    {State#{transition => T1}, []}
            end;
        _ ->
            {State, []}
    end;

%% Deadline elapsed (host timer fired) — force-execute if we still have a live
%% preparing/awaiting transition.
handle({transition_timeout, TransitionId}, State) ->
    case maps:get(transition, State, undefined) of
        _T = #{id := TransitionId} ->
            execute_transition(State);
        _ ->
            {State, []}
    end;

%% --------------------------------------------------------------------------
%% Invalid commit/welcome from any member -> discard current transition and
%% restart with prepare_epoch(1); everyone resubmits key packages.
%% --------------------------------------------------------------------------
handle({invalid_commit_welcome, _UserId}, State) ->
    Members = all_present_users(State),
    State1 = State#{
        established => false,
        epoch => 1,
        transition => undefined,
        key_packages => #{}
    },
    Actions = [
        {send_to_user, U, #{type => prepare_epoch, epoch => 1, version => maps:get(version, State, 0)}}
     || U <- Members
    ],
    {State1, Actions};

%% --------------------------------------------------------------------------
%% Sole-member reset: only one member remains -> prepare_epoch(1) + prepare(0).
%% --------------------------------------------------------------------------
handle({member_left, UserId}, State) ->
    Members = all_present_users(State),
    Remaining = Members -- [UserId],
    case length(Remaining) =< 1 andalso maps:get(established, State, false) of
        true ->
            State1 = reset_to_unestablished(State),
            Actions =
                case Remaining of
                    [Only] ->
                        [
                            {send_to_user, Only, #{
                                type => prepare_epoch,
                                epoch => 1,
                                version => maps:get(version, State, 0)
                            }},
                            {send_to_user, Only, #{
                                type => prepare_transition,
                                transition_id => ?K_INIT_TRANSITION_ID,
                                version => maps:get(version, State, 0)
                            }}
                        ];
                    [] ->
                        []
                end,
            {State1, Actions};
        false ->
            %% Not the sole-member case: schedule a removal of the departed leaf.
            schedule_removal(UserId, State)
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

%% A validate-key-package result reported back by the host.
handle({validate_key_package_result, _UserId, #{valid := true}}, State) ->
    {State, []};
handle({validate_key_package_result, UserId, #{valid := false, reason := Reason}}, State) ->
    %% Drop the offending key package; nothing else to do (client will retry).
    Kps = maps:get(key_packages, State, #{}),
    {State#{key_packages => maps:remove(UserId, Kps)}, [{log_warning, {bad_key_package, UserId, Reason}}]}.

%% --------------------------------------------------------------------------
%% Internal helpers
%% --------------------------------------------------------------------------

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
            {broadcast_channel, #{type := T}} -> T =:= Type;
            _ -> false
        end
    ]).

negotiation_test() ->
    S0 = new_room_state(false),
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
    S0 = new_room_state(false),
    {S1, A1} = handle({join, <<"1001">>, 0}, S0),
    ?assertEqual(0, maps:get(version, S1)),
    ?assertNot(has_rpc(A1, sender_package)),
    ?assertEqual(1, length(A1)).

founding_from_first_key_package_test() ->
    S0 = (new_room_state(false))#{
        version => 1,
        key_packages => #{<<"1001">> => <<"KPA">>}
    },
    {S1, A1} = handle({key_package, <<"1002">>, <<"KPB">>}, S0),
    %% Founding: not yet established -> add transition targeting present users.
    T = maps:get(transition, S1),
    ?assertEqual(preparing, maps:get(phase, T)),
    ?assert(has_rpc(A1, create_proposals)),
    {Args, _Ref} = rpc_args(A1, create_proposals),
    ?assertEqual([<<"KPA">>, <<"KPB">>], lists:sort(maps:get(add_b64, Args))),
    ?assertEqual([], maps:get(remove_indices, Args)).

proposals_relay_and_await_commit_test() ->
    S0 = founding_state(),
    {S1, A1} = handle({proposals_created, <<"PROP">>}, S0),
    T = maps:get(transition, S1),
    ?assertEqual(awaiting_commit, maps:get(phase, T)),
    ?assertEqual(<<"PROP">>, maps:get(proposals_b64, T)),
    ?assert(lists:any(fun({broadcast_channel, _}) -> true; (_) -> false end, A1)).

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
    ?assertEqual(1, maps:get(epoch, S1)),
    ?assert(count_type(A1, prepare_epoch) >= 1).

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
    S0 = (new_room_state(true))#{key_packages => #{<<"1001">> => <<"KP">>}},
    {S1, A1} = handle({validate_key_package_result, <<"1001">>, #{valid => false, reason => <<"bad">>}}, S0),
    ?assertEqual(#{}, maps:get(key_packages, S1)),
    ?assert(lists:any(fun({log_warning, _}) -> true; (_) -> false end, A1)).

%% --- test fixtures -------------------------------------------------------

founding_state() ->
    (new_room_state(false))#{
        version => 1,
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
    (new_room_state(true))#{
        version => 1,
        epoch => 1,
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
        key_packages => maps:put(<<"1003">>, <<"KPC">>, maps:get(key_packages, S)),
        roster => maps:get(roster, S) ++ [#{user_id => <<"1003">>, leaf_index => 2}]
    }.

-endif.
