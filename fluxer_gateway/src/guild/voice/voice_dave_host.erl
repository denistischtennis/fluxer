%% SPDX-License-Identifier: AGPL-3.0-or-later
%%
%% DAVE host layer.
%%
%% Bridges the pure `voice_dave_coordinator' state machine to the running voice
%% process. The coordinator emits abstract actions; this module knows how to turn
%% them into concrete effects (targeted sends, channel broadcasts, async API crypto
%% RPCs, timers) and how to turn inbound wire traffic + RPC results back into
%% coordinator events. All side effects are injected via a callback context so the
%% whole orchestration is unit-testable without a live cluster.
%%
%% The callback context (`ctx()') is a map of functions supplied by the host
%% process (guild_voice_server / dm_voice):
%%
%%   send      :: fun((user_id(), map()) -> ok)          targeted DAVE_PROTOCOL_EVENT
%%   broadcast :: fun((map()) -> ok)                     channel-wide DAVE_PROTOCOL_EVENT
%%   rpc       :: fun((atom(), map(), term()) -> ok)      fire async API call; the
%%                                                      Ref term is echoed back
%%                                                      with the result
%%   timer     :: fun((term(), pos_integer()) -> ok)     schedule a re-injected msg
%%   warn      :: fun((term()) -> ok)                    log a warning

-module(voice_dave_host).

-export([
    apply_event/3,
    drive/3,
    run_actions/2,
    normalize_client_message/2,
    rpc_event/3
]).

-type user_id() :: binary().
-type ctx() :: #{
    send := fun((user_id(), map()) -> ok),
    broadcast := fun((map()) -> ok),
    rpc := fun((atom(), map(), term()) -> ok),
    timer := fun((term(), pos_integer()) -> ok),
    warn := fun((term()) -> ok)
}.

%% --------------------------------------------------------------------------
%% Drive the coordinator once and execute the resulting actions.
%% Returns the new coordinator room state.
%% --------------------------------------------------------------------------
-spec apply_event(term(), voice_dave_coordinator:room_state(), ctx()) ->
    voice_dave_coordinator:room_state().
apply_event(Event, RoomState, Ctx) ->
    {NextRoomState, Actions} = voice_dave_coordinator:handle(Event, RoomState),
    run_actions(Actions, Ctx),
    NextRoomState.
%% --------------------------------------------------------------------------
%% Synchronous driver: run one coordinator event to completion. Non-RPC actions
%% execute immediately via the ctx; each dave_rpc action is resolved through the
%% driver's call_api fun and its result is fed back recursively until the
%% cascade settles. This is what the voice process calls per inbound event so a
%% single handle_call can advance the whole sub-protocol that an RPC triggers.
%%
%% Driver = ctx() with an added `call_api':
%%   call_api :: fun((atom(), map()) -> {ok, map()} | {error, term()})
%% --------------------------------------------------------------------------
-type driver() :: #{
    send := fun((user_id(), map()) -> ok),
    broadcast := fun((map()) -> ok),
    rpc := fun((atom(), map(), term()) -> ok),
    timer := fun((term(), pos_integer()) -> ok),
    warn := fun((term()) -> ok),
    call_api := fun((atom(), map()) -> {ok, map()} | {error, term()})
}.

-spec drive(term(), voice_dave_coordinator:room_state(), driver()) ->
    voice_dave_coordinator:room_state().
drive(Event, RoomState, Driver) ->
    {RoomState1, Actions} = voice_dave_coordinator:handle(Event, RoomState),
    NonRpc = [A || A <- Actions, element(1, A) =/= dave_rpc],
    Rpc = [A || A <- Actions, element(1, A) =:= dave_rpc],
    run_actions(NonRpc, Driver),
    lists:foldl(
        fun({dave_rpc, Method, Args, Ref}, AccRS) ->
            CallApi = maps:get(call_api, Driver),
            case CallApi(Method, Args) of
                {ok, Result} ->
                    drive(rpc_event(Method, Ref, Result), AccRS, Driver);
                {error, Reason} ->
                    Warn = maps:get(warn, Driver),
                    Warn({dave_rpc_failed, Method, Reason}),
                    AccRS
            end
        end,
        RoomState1,
        Rpc
    ).

%% --------------------------------------------------------------------------
%% Execute an action list against the injected effects.
%% --------------------------------------------------------------------------
-spec run_actions([voice_dave_coordinator:action()], ctx()) -> ok.
run_actions([], _Ctx) ->
    ok;
run_actions([{send_to_user, UserId, Payload} | Rest], Ctx) ->
    Send = maps:get(send, Ctx),
    Send(UserId, ensure_binary_type(Payload)),
    run_actions(Rest, Ctx);
run_actions([{broadcast_channel, Payload} | Rest], Ctx) ->
    Broadcast = maps:get(broadcast, Ctx),
    Broadcast(ensure_binary_type(Payload)),
    run_actions(Rest, Ctx);
run_actions([{dave_rpc, Method, Args, Ref} | Rest], Ctx) ->
    Rpc = maps:get(rpc, Ctx),
    Rpc(Method, Args, Ref),
    run_actions(Rest, Ctx);
run_actions([{schedule_timer, Msg, Ms} | Rest], Ctx) ->
    Timer = maps:get(timer, Ctx),
    Timer(Msg, Ms),
    run_actions(Rest, Ctx);
run_actions([{log_warning, Term} | Rest], Ctx) ->
    Warn = maps:get(warn, Ctx),
    Warn(Term),
    run_actions(Rest, Ctx).

%% --------------------------------------------------------------------------
%% Normalize an inbound opcode-17 client message (binary-keyed map) plus the
%% authenticated sender id into a coordinator event.
%% --------------------------------------------------------------------------
-spec normalize_client_message(map(), user_id()) ->
    {ok, term()} | {error, unknown_type}.
normalize_client_message(Raw, SenderUserId) ->
    Type = maps:get(<<"type">>, Raw, undefined),
    Data = maps:get(<<"data">>, Raw, <<>>),
    TransitionId = maps:get(<<"transition_id">>, Raw, 0),
    case Type of
        <<"key_package">> ->
            {ok, {key_package, SenderUserId, Data}};
        <<"ready_for_transition">> ->
            {ok, {ready_for_transition, SenderUserId, TransitionId}};
        <<"commit_welcome">> ->
            {ok, {commit_welcome, SenderUserId, Data}};
        <<"invalid_commit_welcome">> ->
            {ok, {invalid_commit_welcome, SenderUserId}};
        _ ->
            {error, unknown_type}
    end.

%% --------------------------------------------------------------------------
%% Map an RPC method + the echoed Ref term + the decoded API result back into a
%% coordinator event. The coordinator packs any extra identity it needs into the
%% Ref term (e.g. {Ref, UserId} for sender_package), so we can rebuild the event
%% without a separate lookup table.
%% --------------------------------------------------------------------------
-spec rpc_event(atom(), term(), map()) -> term().
rpc_event(sender_package, {_Ref, UserId}, Result) ->
    {sender_package_result, UserId, maps:get(<<"sender_package_b64">>, Result, <<>>)};
rpc_event(create_proposals, _Ref, Result) ->
    {proposals_created, maps:get(<<"proposals_b64">>, Result, <<>>)};
rpc_event(parse_commit, _Ref, #{<<"ok">> := true} = Result) ->
    {commit_parsed, ok, decode_parsed(Result)};
rpc_event(parse_commit, _Ref, #{<<"ok">> := false} = Result) ->
    {commit_parsed, error, maps:get(<<"reason">>, Result, undefined)};
rpc_event(validate_key_package, {_Ref, UserId}, Result) ->
    %% The API returns a JSON map with binary keys; normalize to the atom-keyed
    %% shape the coordinator pattern-matches on. Missing `valid' defaults to
    %% false so a malformed response can never promote a key package.
    Valid = case maps:get(<<"valid">>, Result, false) of
        true -> true;
        _ -> false
    end,
    Reason = maps:get(<<"reason">>, Result, <<>>),
    {validate_key_package_result, UserId, #{valid => Valid, reason => Reason}}.

%% Translate the API's parse-commit JSON into the coordinator's parsed map shape.
decode_parsed(Result) ->
    Roster = [
        #{user_id => maps:get(<<"user_id">>, R, <<>>), leaf_index => maps:get(<<"leaf_index">>, R, 0)}
     || R <- maps:get(<<"roster">>, Result, [])
    ],
    #{
        new_epoch => maps:get(<<"new_epoch">>, Result, undefined),
        roster => Roster,
        welcome_b64 => maps:get(<<"welcome_b64">>, Result, undefined),
        commit_b64 => maps:get(<<"commit_b64">>, Result, <<>>)
    }.

%% The coordinator builds payloads with atom event types; the wire uses binaries.
%% Convert the `type' key to a binary so downstream serialization is uniform.
ensure_binary_type(Payload) when is_map(Payload) ->
    case maps:get(type, Payload, undefined) of
        T when is_atom(T) -> Payload#{type => atom_to_binary(T, utf8)};
        _ -> Payload
    end;
ensure_binary_type(Payload) ->
    Payload.

%% ==========================================================================
%% Tests
%% ==========================================================================
-ifdef(TEST).
-include_lib("eunit/include/eunit.hrl").

%% Recording context: accumulates every effect into an ETS-free process-less
%% accumulator passed by reference through a list cell (we use a simple agent).
new_recorder() ->
    spawn(fun() -> recorder_loop([]) end).

recorder_loop(Acc) ->
    receive
        {record, Item} ->
            recorder_loop([Item | Acc]);
        {get, From} ->
            From ! {recorded, lists:reverse(Acc)},
            recorder_loop(Acc);
        stop ->
            ok
    end.

record(Pid, Item) ->
    Pid ! {record, Item}.

get_recorded(Pid) ->
    Pid ! {get, self()},
    receive
        {recorded, L} -> L
    after
        1000 -> timeout
    end.

recording_ctx(Pid) ->
    #{
        send => fun(U, P) -> record(Pid, {send, U, P}) end,
        broadcast => fun(P) -> record(Pid, {broadcast, P}) end,
        rpc => fun(M, A, R) -> record(Pid, {rpc, M, A, R}) end,
        timer => fun(M, T) -> record(Pid, {timer, M, T}) end,
        warn => fun(W) -> record(Pid, {warn, W}) end
    }.

%% --- inbound normalization -------------------------------------------------
normalize_key_package_test() ->
    ?assertEqual(
        {ok, {key_package, <<"1">>, <<"KP">>}},
        normalize_client_message(#{<<"type">> => <<"key_package">>, <<"data">> => <<"KP">>}, <<"1">>)
    ).

normalize_ready_test() ->
    ?assertEqual(
        {ok, {ready_for_transition, <<"2">>, 7}},
        normalize_client_message(
            #{<<"type">> => <<"ready_for_transition">>, <<"transition_id">> => 7}, <<"2">>
        )
    ).

normalize_invalid_test() ->
    ?assertEqual(
        {ok, {invalid_commit_welcome, <<"3">>}},
        normalize_client_message(#{<<"type">> => <<"invalid_commit_welcome">>}, <<"3">>)
    ).

normalize_unknown_test() ->
    ?assertEqual(
        {error, unknown_type},
        normalize_client_message(#{<<"type">> => <<"bogus">>}, <<"1">>)
    ).

%% --- full founding orchestration through the host --------------------------
founding_drives_join_then_sender_package_test() ->
    Rec = new_recorder(),
    Ctx = recording_ctx(Rec),
    S0 = voice_dave_coordinator:new_room_state(false, <<"42">>),
    %% Join triggers select_protocol_ack + a sender_package RPC.
    S1 = apply_event({join, <<"1001">>, 1}, S0, Ctx),
    Recorded1 = get_recorded(Rec),
    ?assert(lists:member({send, <<"1001">>, #{type => <<"select_protocol_ack">>, version => 1, target_user_id => <<"1001">>}}, Recorded1)),
    ?assertMatch([{rpc, sender_package, _, {_, <<"1001">>}} | _], [R || R <- Recorded1, element(1, R) =:= rpc]),
    %% Feed the sender package result back -> external_sender_package to the user.
    Ref = case [R || R <- Recorded1, element(1, R) =:= rpc] of
        [{rpc, _, _, R0} | _] -> R0
    end,
    Ev = rpc_event(sender_package, Ref, #{<<"sender_package_b64">> => <<"SENDER">>}),
    _S2 = apply_event(Ev, S1, Ctx),
    Recorded2 = get_recorded(Rec),
    ?assert(lists:member({send, <<"1001">>, #{type => <<"external_sender_package">>, data => <<"SENDER">>}}, Recorded2)),
    ok.

%% Key package arrival requests DS validation first; only after a valid result
%% does the add-proposals RPC fire.
key_package_triggers_create_proposals_test() ->
    Rec = new_recorder(),
    Ctx = recording_ctx(Rec),
    S0 = voice_dave_coordinator:new_room_state(false, <<"42">>),
    S1 = apply_event({join, <<"1001">>, 1}, S0, Ctx),
    S2 = apply_event({key_package, <<"1001">>, <<"KP1">>}, S1, Ctx),
    Recorded1 = get_recorded(Rec),
    ?assert(lists:any(
        fun({rpc, validate_key_package, Args, _}) ->
            maps:get(key_package_b64, Args) =:= <<"KP1">> andalso
                maps:get(user_id, Args) =:= <<"1001">>;
           (_) ->
            false
        end,
        Recorded1
    )),
    ?assertEqual(#{}, maps:get(key_packages, S2, #{})),
    S3 = apply_event({validate_key_package_result, <<"1001">>, #{valid => true}}, S2, Ctx),
    Recorded = get_recorded(Rec),
    ?assert(lists:any(
        fun({rpc, create_proposals, Args, _}) ->
            lists:member(<<"KP1">>, maps:get(add_b64, Args));
           (_) ->
            false
        end,
        Recorded
    )),
    ?assert(maps:get(transition, S3, undefined) =/= undefined),
    ok.

%% proposals_created relays proposals to targets and flips phase to awaiting_commit.
proposals_created_broadcasts_test() ->
    Rec = new_recorder(),
    Ctx = recording_ctx(Rec),
    S0 = voice_dave_coordinator:new_room_state(false, <<"42">>),
    S1 = apply_event({join, <<"1001">>, 1}, S0, Ctx),
    S2 = apply_event({key_package, <<"1001">>, <<"KP1">>}, S1, Ctx),
    S2b = apply_event({validate_key_package_result, <<"1001">>, #{valid => true}}, S2, Ctx),
    S3 = apply_event({proposals_created, <<"PROPS">>}, S2b, Ctx),
    Recorded = get_recorded(Rec),
    ?assert(lists:any(fun({broadcast, #{type := <<"proposals">>}}) -> true; (_) -> false end, Recorded)),
    T = maps:get(transition, S3),
    ?assertEqual(awaiting_commit, maps:get(phase, T)),
    ok.

%% invalid_commit_welcome from an admitted member tears the group down and
%% asks everyone to re-init. The internal MLS epoch goes to 0 (a fresh
%% group is founded there); the wire prepare_epoch value 1 means "brand-new
%% group" per the DAVE op semantics.
invalid_resets_epoch_test() ->
    Rec = new_recorder(),
    Ctx = recording_ctx(Rec),
    S0 = voice_dave_coordinator:new_room_state(true, <<"42">>),
    S0b = S0#{
        epoch => 3,
        joined => #{<<"1001">> => true, <<"1002">> => true},
        key_packages => #{<<"1001">> => <<"KP">>, <<"1002">> => <<"KP2">>}
    },
    S1 = apply_event({invalid_commit_welcome, <<"1001">>}, S0b, Ctx),
    Recorded = get_recorded(Rec),
    ?assertEqual(false, maps:get(established, S1)),
    ?assertEqual(0, maps:get(epoch, S1)),
    Prepares = [P || {send, _, P} <- Recorded, maps:get(type, P, undefined) =:= <<"prepare_epoch">>],
    ?assertEqual(2, length(Prepares)),
    ok.

%% member_left with >1 remaining schedules a batched removal timer.
member_left_schedules_removal_test() ->
    Rec = new_recorder(),
    Ctx = recording_ctx(Rec),
    S0 = voice_dave_coordinator:new_room_state(true, <<"42">>),
    S0b = S0#{
        key_packages => #{<<"1001">> => <<"K1">>, <<"1002">> => <<"K2">>, <<"1003">> => <<"K3">>},
        roster => [
            #{user_id => <<"1001">>, leaf_index => 0},
            #{user_id => <<"1002">>, leaf_index => 1},
            #{user_id => <<"1003">>, leaf_index => 2}
        ]
    },
    S1 = apply_event({member_left, <<"1002">>}, S0b, Ctx),
    Recorded = get_recorded(Rec),
    ?assert(lists:any(fun({timer, flush_removals, _}) -> true; (_) -> false end, Recorded)),
    ?assertEqual([1], maps:get(pending_removals, S1)),
    ok.

%% sole-member reset emits prepare_epoch + prepare_transition to the only user.
sole_member_reset_test() ->
    Rec = new_recorder(),
    Ctx = recording_ctx(Rec),
    S0 = voice_dave_coordinator:new_room_state(true, <<"42">>),
    S0b = S0#{
        key_packages => #{<<"1001">> => <<"K1">>, <<"1002">> => <<"K2">>},
        roster => [
            #{user_id => <<"1001">>, leaf_index => 0},
            #{user_id => <<"1002">>, leaf_index => 1}
        ]
    },
    S1 = apply_event({member_left, <<"1002">>}, S0b, Ctx),
    Recorded = get_recorded(Rec),
    ?assertEqual(false, maps:get(established, S1)),
    Types = [maps:get(type, P, undefined) || {send, <<"1001">>, P} <- Recorded],
    ?assert(lists:member(prepare_epoch, Types) orelse lists:member(<<"prepare_epoch">>, Types)),
    ?assert(lists:member(prepare_transition, Types) orelse lists:member(<<"prepare_transition">>, Types)),
    ok.

%% --- rpc_event mapping ---------------------------------------------------
rpc_event_sender_test() ->
    ?assertEqual(
        {sender_package_result, <<"42">>, <<"PKG">>},
        rpc_event(sender_package, {make_ref(), <<"42">>}, #{<<"sender_package_b64">> => <<"PKG">>})
    ).

rpc_event_parse_ok_test() ->
    Result = #{
        <<"ok">> => true,
        <<"new_epoch">> => 5,
        <<"roster">> => [#{<<"user_id">> => <<"1">>, <<"leaf_index">> => 0}],
        <<"welcome_b64">> => <<"W">>,
        <<"commit_b64">> => <<"C">>
    },
    {commit_parsed, ok, Parsed} = rpc_event(parse_commit, make_ref(), Result),
    ?assertEqual(5, maps:get(new_epoch, Parsed)),
    ?assertEqual([#{user_id => <<"1">>, leaf_index => 0}], maps:get(roster, Parsed)),
    ok.

rpc_event_parse_error_test() ->
    {commit_parsed, error, <<"bad">>} = rpc_event(parse_commit, make_ref(), #{
        <<"ok">> => false, <<"reason">> => <<"bad">>
    }),
    ok.

rpc_event_validate_test() ->
    ?assertEqual(
        {validate_key_package_result, <<"7">>, #{valid => false, reason => <<>>}},
        rpc_event(validate_key_package, {make_ref(), <<"7">>}, #{<<"valid">> => false})
    ).

%% --- action execution completeness ---------------------------------------
run_actions_all_types_test() ->
    Rec = new_recorder(),
    Ctx = recording_ctx(Rec),
    Actions = [
        {send_to_user, <<"u1">>, #{type => x}},
        {broadcast_channel, #{type => y}},
        {dave_rpc, m, #{a => 1}, ref},
        {schedule_timer, msg, 100},
        {log_warning, w}
    ],
    ok = run_actions(Actions, Ctx),
    R = get_recorded(Rec),
    ?assertEqual(5, length(R)),
    ok.

%% --- synchronous full-handshake cascade ----------------------------------
stub_api(sender_package, _Args) ->
    {ok, #{<<"sender_package_b64">> => <<"SENDER">>}};
stub_api(create_proposals, _Args) ->
    {ok, #{<<"proposals_b64">> => <<"PROPS">>}};
stub_api(validate_key_package, _Args) ->
    {ok, #{<<"valid">> => true, <<"reason">> => <<>>}};
stub_api(parse_commit, _Args) ->
    {ok, #{
        <<"ok">> => true,
        <<"new_epoch">> => 1,
        <<"roster">> => [#{<<"user_id">> => <<"1001">>, <<"leaf_index">> => 0}],
        <<"welcome_b64">> => <<"W">>,
        <<"commit_b64">> => <<"C">>
    }}.

driving_founding_reaches_established_test() ->
    Rec = new_recorder(),
    Driver = (recording_ctx(Rec))#{call_api => fun stub_api/2},
    S0 = voice_dave_coordinator:new_room_state(false, <<"42">>),
    %% Join cascades: select_protocol_ack + external_sender_package (via RPC).
    S1 = drive({join, <<"1001">>, 1}, S0, Driver),
    R1 = get_recorded(Rec),
    ?assert(lists:any(fun({send, <<"1001">>, #{type := <<"select_protocol_ack">>}}) -> true; (_) -> false end, R1)),
    ?assert(lists:any(fun({send, <<"1001">>, #{type := <<"external_sender_package">>}}) -> true; (_) -> false end, R1)),
    ?assertEqual(false, maps:get(established, S1)),
    %% Key package -> add transition -> proposals relayed.
    S2 = drive({key_package, <<"1001">>, <<"KPA">>}, S1, Driver),
    R2 = get_recorded(Rec),
    ?assert(lists:any(fun({broadcast, #{type := <<"proposals">>}}) -> true; (_) -> false end, R2)),
    %% Committer commits -> parse_commit RPC -> announce + established.
    S3 = drive({commit_welcome, <<"1001">>, <<"BUNDLE">>}, S2, Driver),
    R3 = get_recorded(Rec),
    ?assertEqual(true, maps:get(established, S3)),
    ?assertEqual(1, maps:get(epoch, S3)),
    ?assert(lists:any(fun({send, <<"1001">>, #{type := <<"announce_commit_transition">>}}) -> true; (_) -> false end, R3)),
    ok.

%% API failure halts the cascade without corrupting state.
drive_api_error_halts_test() ->
    Rec = new_recorder(),
    FailApi = fun(sender_package, _) -> {error, down}; (_, _) -> {ok, #{}} end,
    Driver = (recording_ctx(Rec))#{call_api => FailApi},
    S0 = voice_dave_coordinator:new_room_state(false, <<"42">>),
    _S1 = drive({join, <<"1001">>, 1}, S0, Driver),
    %% ack still sent, but no external_sender_package (RPC failed).
    R1 = get_recorded(Rec),
    ?assert(lists:any(fun({send, <<"1001">>, #{type := <<"select_protocol_ack">>}}) -> true; (_) -> false end, R1)),
    ?assertNot(lists:any(fun({send, _, #{type := <<"external_sender_package">>}}) -> true; (_) -> false end, R1)),
    ok.

-endif.
