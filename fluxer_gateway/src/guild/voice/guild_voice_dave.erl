%% SPDX-License-Identifier: AGPL-3.0-or-later
%%
%% Guild-side DAVE integration. Builds a real `voice_dave_host:driver()' whose
%% effects hit the running system: targeted/broadcast dispatch goes out through
%% `presence_manager:dispatch_to_user' as a DAVE_PROTOCOL_EVENT, crypto RPCs go
%% to the fluxer_api signer through `rpc_client:call', and timers are scheduled
%% with `erlang:send_after'. The per-channel MLS room state is threaded through by
%% the owning `guild_voice_server'.

-module(guild_voice_dave).

-include_lib("kernel/include/logger.hrl").

-export([
    build_driver/2,
    drive_join/5,
    negotiate_join/4,
    drive_message/5,
    drive_member_left/4,
    drive_timer/4,
    api_call/2,
    method_to_type/1
]).

-type user_id() :: binary().
-type channel_id() :: binary().

%% --------------------------------------------------------------------------
%% Build the driver map for a channel.
%%
%%   MemberProvider :: fun(() -> [user_id()])  current channel members (excludes
%%                    the per-message sender nuance; broadcast fans to all).
%% --------------------------------------------------------------------------
-spec build_driver(channel_id(), fun(() -> [user_id()])) -> voice_dave_host:driver().
build_driver(ChannelId, MemberProvider) ->
    #{
        send =>
            fun(UserId, Payload) ->
                dispatch(UserId, Payload, ChannelId)
            end,
        broadcast =>
            fun(Payload) ->
                [dispatch(U, Payload, ChannelId) || U <- MemberProvider()]
            end,
        rpc =>
            fun(_Method, _Args, _Ref) ->
                %% drive/3 resolves RPCs synchronously via call_api; this fire-and-
                %% forget callback exists only to satisfy the ctx contract when a
                %% non-driving caller uses run_actions/2 directly.
                ok
            end,
        timer =>
            fun(Msg, Ms) ->
                erlang:send_after(Ms, self(), {dave_timer, ChannelId, Msg})
            end,
        warn =>
            fun(Term) ->
                ?LOG_WARNING("dave host warning", #{term => Term, channel_id => ChannelId})
            end,
        call_api =>
            fun(Method, Args) ->
                api_call(Method, Args)
            end
    }.

%% --------------------------------------------------------------------------
%% High-level entry points called by the owning guild_voice_server. Each threads
%% the per-channel MLS room state through the synchronous host driver and returns
%% the updated state. `MemberProvider' supplies current channel member ids for
%% broadcast fan-out.
%% --------------------------------------------------------------------------
-spec drive_join(user_id(), non_neg_integer(), channel_id(), voice_dave_coordinator:room_state(), fun(
    () -> [user_id()]
)) ->
    {non_neg_integer(), voice_dave_coordinator:room_state()}.
drive_join(UserId, MaxVersion, ChannelId, RoomState, MemberProvider) ->
    %% The channel id must ride along on every downlink event; the client drops
    %% DAVE_PROTOCOL_EVENTs without a usable channel_id, so passing <<>> here
    %% would silently kill the join handshake.
    Driver = build_driver(ChannelId, MemberProvider),
    NewState = voice_dave_host:drive({join, UserId, MaxVersion}, RoomState, Driver),
    {maps:get(version, NewState, 0), NewState}.

%% --------------------------------------------------------------------------
%% Join negotiation for voice connection flows (fresh join *and* channel move).
%% Owns the `dave_rooms' map lookup/insert so every entry point behaves the
%% same: an E2EE participant entering a channel must always reach the MLS
%% coordinator, otherwise the connection would silently stay unencrypted.
%% Returns the negotiated protocol version plus the updated owning state.
%% --------------------------------------------------------------------------
-spec negotiate_join(user_id(), non_neg_integer(), channel_id(), map()) ->
    {ok, non_neg_integer(), map()} | {error, term(), map()}.
negotiate_join(UserBin, MaxVersion, ChIdBin, State) ->
    Rooms = maps:get(dave_rooms, State, #{}),
    RS0 =
        case maps:get(ChIdBin, Rooms, undefined) of
            undefined -> voice_dave_coordinator:new_room_state(false, ChIdBin);
            R -> R
        end,
    Members = fun() -> maps:keys(maps:get(key_packages, RS0, #{})) end,
    try drive_join(UserBin, MaxVersion, ChIdBin, RS0, Members) of
        {V, RS1} when is_integer(V) ->
            {ok, V, State#{dave_rooms => Rooms#{ChIdBin => RS1}}};
        Other ->
            ?LOG_WARNING("dave join returned unexpected result", #{
                channel_id => ChIdBin, result => Other
            }),
            {error, {unexpected_result, Other}, State}
    catch
        Class:Reason ->
            ?LOG_WARNING("dave join trigger failed", #{
                channel_id => ChIdBin, class => Class, reason => Reason
            }),
            {error, {Class, Reason}, State}
    end.

-spec drive_message(channel_id(), map(), user_id(), voice_dave_coordinator:room_state(), fun(
    () -> [user_id()]
)) ->
    voice_dave_coordinator:room_state().
drive_message(ChannelId, Raw, SenderUserId, RoomState, MemberProvider) ->
    Driver = build_driver(ChannelId, MemberProvider),
    case voice_dave_host:normalize_client_message(Raw, SenderUserId) of
        {ok, Event} ->
            voice_dave_host:drive(Event, RoomState, Driver);
        {error, unknown_type} ->
            ?LOG_WARNING("dave unknown inbound message type", #{
                channel_id => ChannelId, raw => maps:get(<<"type">>, Raw, undefined)
            }),
            RoomState
    end.

-spec drive_member_left(channel_id(), user_id(), voice_dave_coordinator:room_state(), fun(
    () -> [user_id()]
)) ->
    voice_dave_coordinator:room_state().
drive_member_left(ChannelId, UserId, RoomState, MemberProvider) ->
    Driver = build_driver(ChannelId, MemberProvider),
    voice_dave_host:drive({member_left, UserId}, RoomState, Driver).

-spec drive_timer(channel_id(), term(), voice_dave_coordinator:room_state(), fun(
    () -> [user_id()]
)) ->
    voice_dave_coordinator:room_state().
drive_timer(ChannelId, Msg, RoomState, MemberProvider) ->
    Driver = build_driver(ChannelId, MemberProvider),
    voice_dave_host:drive(Msg, RoomState, Driver).

%% Dispatch a DAVE event to a single user's session. The coordinator keys users
%% by binary snowflake strings; presence_manager indexes by integer user ids, so
%% convert on the boundary. Non-numeric ids are skipped defensively.
dispatch(UserId, Payload, ChannelId) ->
    Base = to_binary_keys(Payload),
    Enriched = Base#{<<"channel_id">> => ChannelId},
    case to_int_user(UserId) of
        {ok, IntUid} ->
            presence_manager:dispatch_to_user(IntUid, dave_protocol_event, Enriched);
        error ->
            ?LOG_WARNING("dave dispatch skipped: non-numeric user id", #{user_id => UserId})
    end.

to_int_user(U) when is_binary(U) ->
    try
        {ok, binary_to_integer(U)}
    catch
        _:_ -> error
    end;
to_int_user(U) when is_integer(U) ->
    {ok, U};
to_int_user(_) ->
    error.

%% --------------------------------------------------------------------------
%% Synchronous crypto RPC to the API signer. Maps the coordinator's method +
%% atom-keyed args onto the internal RPC discriminated union and returns the
%% decoded `data' payload as a binary-keyed map.
%% --------------------------------------------------------------------------
-spec api_call(atom(), map()) -> {ok, map()} | {error, term()}.
api_call(Method, Args) ->
    Type = method_to_type(Method),
    Base = to_binary_keys(Args),
    Request = Base#{<<"type">> => Type},
    case rpc_client:call(Request) of
        {ok, Data} when is_map(Data) ->
            %% NOTE: rpc_client:call/1 already unwraps the HTTP envelope's
            %% `data' field (handle_http_response returns {ok, Data}). Do NOT
            %% unwrap again here — doing so silently emptied every DAVE result.
            {ok, Data};
        {error, _} = Err ->
            Err;
        Other ->
            {error, {unexpected_rpc_result, Other}}
    end.

-spec method_to_type(atom()) -> binary().
method_to_type(sender_package) -> <<"dave_sender_package">>;
method_to_type(create_proposals) -> <<"dave_create_proposals">>;
method_to_type(parse_commit) -> <<"dave_parse_commit">>;
method_to_type(validate_key_package) -> <<"dave_validate_key_package">>.

%% Recursively convert atom keys to binary so the JSON encoder produces the
%% snake_case string keys the API routes expect. Binary leaves/values pass through.
to_binary_keys(Map) when is_map(Map) ->
    maps:fold(
        fun(K, V, Acc) ->
            BK = key_to_binary(K),
            Acc#{BK => to_binary_keys(V)}
        end,
        #{},
        Map
    );
to_binary_keys(List) when is_list(List) ->
    [to_binary_keys(X) || X <- List];
to_binary_keys(Val) ->
    Val.

key_to_binary(K) when is_atom(K) -> atom_to_binary(K, utf8);
key_to_binary(K) when is_binary(K) -> K;
key_to_binary(K) -> K.

%% ==========================================================================
%% Tests
%% ==========================================================================
-ifdef(TEST).
-include_lib("eunit/include/eunit.hrl").

%% --- method mapping ------------------------------------------------------
method_to_type_all_test() ->
    ?assertEqual(<<"dave_sender_package">>, method_to_type(sender_package)),
    ?assertEqual(<<"dave_create_proposals">>, method_to_type(create_proposals)),
    ?assertEqual(<<"dave_parse_commit">>, method_to_type(parse_commit)),
    ?assertEqual(<<"dave_validate_key_package">>, method_to_type(validate_key_package)).

%% --- key conversion -----------------------------------------------------
to_binary_keys_nested_test() ->
    In = #{
        group_id => 123,
        add_b64 => [<<"A">>, <<"B">>],
        known_roster => [#{user_id => <<"1">>, leaf_index => 0}]
    },
    Out = to_binary_keys(In),
    ?assertEqual(123, maps:get(<<"group_id">>, Out)),
    ?assertEqual([<<"A">>, <<"B">>], maps:get(<<"add_b64">>, Out)),
    Roster = maps:get(<<"known_roster">>, Out),
    [Entry] = Roster,
    ?assertEqual(<<"1">>, maps:get(<<"user_id">>, Entry)),
    ?assertEqual(0, maps:get(<<"leaf_index">>, Entry)).

%% --- api_call happy path (meck) -----------------------------------------
api_call_ok_test() ->
    meck:new(rpc_client, [passthrough]),
    try
        meck:expect(
            rpc_client,
            call,
            fun(Req) ->
                ?assertEqual(<<"dave_sender_package">>, maps:get(<<"type">>, Req)),
                {ok, #{<<"sender_package_b64">> => <<"PKG">>}}
            end
        ),
        {ok, Data} = api_call(sender_package, #{}),
        ?assertEqual(<<"PKG">>, maps:get(<<"sender_package_b64">>, Data)),
        true = meck:validate(rpc_client)
    after
        meck:unload(rpc_client)
    end.

api_call_error_propagates_test() ->
    meck:new(rpc_client, [passthrough]),
    try
        meck:expect(rpc_client, call, fun(_) -> {error, timeout} end),
        ?assertEqual({error, timeout}, api_call(create_proposals, #{group_id => 1}))
    after
        meck:unload(rpc_client)
    end.

api_call_unexpected_shape_test() ->
    meck:new(rpc_client, [passthrough]),
    try
        meck:expect(rpc_client, call, fun(_) -> garbage end),
        ?assertMatch({error, {unexpected_rpc_result, garbage}}, api_call(parse_commit, #{}))
    after
        meck:unload(rpc_client)
    end.

%% --- driver send/broadcast fan-out (meck on presence_manager) -----------
driver_send_dispatches_integer_uid_test() ->
    meck:new(presence_manager, [passthrough]),
    try
        meck:expect(presence_manager, dispatch_to_user, fun(_, _, _) -> ok end),
        Driver = build_driver(<<"chan1">>, fun() -> [] end),
        Send = maps:get(send, Driver),
        %% binary snowflake must arrive at presence_manager as an INTEGER
        Send(<<"1000000000000000001">>, #{<<"type">> => <<"welcome">>}),
        ?assert(
            meck:called(
                presence_manager,
                dispatch_to_user,
                [1000000000000000001, dave_protocol_event, '_']
            )
        )
    after
        meck:unload(presence_manager)
    end.

driver_send_skips_non_numeric_test() ->
    meck:new(presence_manager, [passthrough]),
    try
        meck:expect(presence_manager, dispatch_to_user, fun(_, _, _) -> ok end),
        Driver = build_driver(<<"c">>, fun() -> [] end),
        Send = maps:get(send, Driver),
        Send(<<"not-a-snowflake">>, #{<<"type">> => <<"x">>}),
        %% non-numeric id must never reach presence_manager
        ?assertEqual(0, meck:num_calls(presence_manager, dispatch_to_user, '_'))
    after
        meck:unload(presence_manager)
    end.

driver_broadcast_fans_to_members_test() ->
    meck:new(presence_manager, [passthrough]),
    try
        meck:expect(presence_manager, dispatch_to_user, fun(_, _, _) -> ok end),
        Members = [<<"111">>, <<"222">>, <<"333">>],
        Driver = build_driver(<<"ch">>, fun() -> Members end),
        Broadcast = maps:get(broadcast, Driver),
        Broadcast(#{<<"type">> => <<"proposals">>}),
        ?assertEqual(3, meck:num_calls(presence_manager, dispatch_to_user, '_')),
        lists:foreach(
            fun(U) ->
                ?assert(
                    meck:called(presence_manager, dispatch_to_user, [
                        U, dave_protocol_event, '_'
                    ])
                )
            end,
            [111, 222, 333]
        )
    after
        meck:unload(presence_manager)
    end.

%% --- full driving through the real host + stubbed api --------------------
founding_via_guild_driver_establishes_test() ->
    meck:new(presence_manager, [passthrough]),
    try
        meck:expect(presence_manager, dispatch_to_user, fun(_, _, _) -> ok end),
        %% call_api returns canned DS results matching the real wire shapes.
        CallApi =
            fun
                (sender_package, _) ->
                    {ok, #{<<"sender_package_b64">> => <<"SENDER">>}};
                (validate_key_package, _) ->
                    {ok, #{<<"valid">> => true, <<"reason">> => <<>>}};
                (create_proposals, _) ->
                    {ok, #{<<"proposals_b64">> => <<"PROPS">>}};
                (parse_commit, _) ->
                    {ok, #{
                        <<"ok">> => true,
                        <<"new_epoch">> => 1,
                        <<"roster">> => [#{<<"user_id">> => <<"1001">>, <<"leaf_index">> => 0}],
                        <<"commit_b64">> => <<"C">>,
                        <<"welcome_b64">> => <<"W">>
                    }}
            end,
        Driver0 = build_driver(<<"g_ch">>, fun() -> [] end),
        Driver = Driver0#{call_api => CallApi},
        S0 = voice_dave_coordinator:new_room_state(false, <<"42">>),
        S1 = voice_dave_host:drive({join, <<"1001">>, 1}, S0, Driver),
        S2 = voice_dave_host:drive({key_package, <<"1001">>, <<"KPA">>}, S1, Driver),
        S3 = voice_dave_host:drive({commit_welcome, <<"1001">>, <<"BUNDLE">>}, S2, Driver),
        ?assertEqual(true, maps:get(established, S3)),
        ?assertEqual(1, maps:get(epoch, S3)),
        Types = dispatched_types(),
        ?assert(has_type(<<"select_protocol_ack">>, Types)),
        ?assert(has_type(<<"external_sender_package">>, Types)),
        ?assert(has_type(<<"announce_commit_transition">>, Types))
    after
        meck:unload(presence_manager)
    end.

%% Extract the DAVE event types from every dispatch_to_user call recorded by meck.
dispatched_types() ->
    lists:filtermap(
        fun
            ({_Pid, {_Mod, _Fun, [_, _Evt, Data]}, _Ret}) when is_map(Data) ->
                case maps:get(<<"type">>, Data, undefined) of
                    undefined ->
                        false;
                    T ->
                        {true, T}
                end;
            (_) ->
                false
        end,
        meck:history(presence_manager)
    ).

has_type(T, Types) ->
    lists:member(T, Types) orelse lists:member(binary_to_atom(T, utf8), Types).

%% --- high-level entry points -------------------------------------------
drive_join_returns_negotiated_version_test() ->
    meck:new(presence_manager, [passthrough]),
    meck:new(rpc_client, [passthrough]),
    try
        meck:expect(presence_manager, dispatch_to_user, fun(_, _, _) -> ok end),
        meck:expect(
            rpc_client,
            call,
            fun(_) -> {ok, #{<<"sender_package_b64">> => <<"S">>}} end
        ),
        S0 = voice_dave_coordinator:new_room_state(false, <<"42">>),
        {Version, S1} = drive_join(<<"1001">>, 1, <<"42">>, S0, fun() -> [] end),
        ?assertEqual(1, Version),
        ?assertEqual(1, maps:get(version, S1))
    after
        meck:unload(rpc_client),
        meck:unload(presence_manager)
    end.

drive_message_normalizes_and_drives_test() ->
    meck:new(presence_manager, [passthrough]),
    meck:new(rpc_client, [passthrough]),
    try
        meck:expect(presence_manager, dispatch_to_user, fun(_, _, _) -> ok end),
        meck:expect(
            rpc_client,
            call,
            fun(_) ->
                {ok, #{<<"proposals_b64">> => <<"P">>, <<"valid">> => true}}
            end
        ),
        S0 = (voice_dave_coordinator:new_room_state(false, <<"42">>))#{
            joined => #{<<"1001">> => true}
        },
        S1 = drive_message(
            <<"ch">>,
            #{<<"type">> => <<"key_package">>, <<"data">> => <<"KP">>},
            <<"1001">>,
            S0,
            fun() -> [] end
        ),
        %% key_package on an unestablished room creates an add transition
        ?assert(maps:get(transition, S1, undefined) =/= undefined)
    after
        meck:unload(rpc_client),
        meck:unload(presence_manager)
    end.

drive_message_unknown_type_is_noop_test() ->
    RoomState = voice_dave_coordinator:new_room_state(false, <<"42">>),
    Result = drive_message(
        <<"ch">>, #{<<"type">> => <<"garbage">>}, <<"1001">>, RoomState, fun() -> [] end
    ),
    ?assertEqual(RoomState, Result).

-endif.
