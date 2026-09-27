%% SPDX-License-Identifier: AGPL-3.0-or-later

-module(session_voice).
-typing([eqwalizer]).

-export([
    init_voice_queue/0,
    process_voice_queue/1,
    handle_voice_state_update/2,
    handle_dave_protocol_message/2,
    handle_voice_disconnect/1
]).

-export_type([session_state/0, voice_state_reply/0]).

-type session_state() :: session:session_state().

-type voice_state_reply() ::
    {reply, ok, session_state()}
    | {reply, {error, term(), term()}, session_state()}.

-spec init_voice_queue() -> #{voice_queue := queue:queue(), voice_queue_timer := undefined}.
init_voice_queue() ->
    #{voice_queue => queue:new(), voice_queue_timer => undefined}.

-spec process_voice_queue(session_state()) -> session_state().
process_voice_queue(State) ->
    VoiceQueue = maps:get(voice_queue, State, queue:new()),
    case queue:out(VoiceQueue) of
        {empty, _} ->
            State;
        {{value, Item}, NewQueue} ->
            process_voice_queue_item(Item, State#{voice_queue => NewQueue})
    end.

-spec process_voice_queue_item(map(), session_state()) -> session_state().
process_voice_queue_item(Item, State) ->
    case maps:get(type, Item, undefined) of
        voice_state_update ->
            Data = maps:get(data, Item),
            {reply, _, NewState} = session_voice_connect:handle_voice_state_update(Data, State),
            NewState;
        _ ->
            State
    end.

-spec handle_voice_state_update(map(), session_state()) -> voice_state_reply().
handle_voice_state_update(Data, State) ->
    session_voice_connect:handle_voice_state_update(Data, State).

%% --------------------------------------------------------------------------
%% Route an inbound opcode-17 DAVE message to whatever owns the MLS room for
%% that channel: the guild voice server when a `guild_id` is present, otherwise
%% the DM call's gen_server. The authenticated session user id is passed as a
%% binary snowflake (the coordinator's key representation).
%% --------------------------------------------------------------------------
-spec handle_dave_protocol_message(map(), session_state()) -> voice_state_reply().
handle_dave_protocol_message(Data, State) when is_map(Data) ->
    ChannelIdBin = maps:get(<<"channel_id">>, Data, <<>>),
    SenderBin = integer_to_binary(maps:get(user_id, State)),
    case parse_guild_id(maps:get(<<"guild_id">>, Data, null)) of
        {ok, GId} ->
            case guild_voice_server:lookup(GId) of
                {ok, VPid} ->
                    try
                        gen_server:call(
                            VPid, {dave_message, ChannelIdBin, SenderBin, Data}, 5000
                        )
                    catch
                        _:_ -> ok
                    end;
                {error, not_found} ->
                    logger:warning("dave message: no voice server for guild", #{guild_id => GId})
            end;
        error ->
            route_dave_to_call(ChannelIdBin, SenderBin, Data)
    end,
    {reply, ok, State}.

%% A DAVE message without `guild_id` belongs to a DM call. The call gen_server is
%% the single owner of that call's MLS room, so route by channel id. Unknown or
%% already-ended calls are logged and dropped rather than failing the session.
-spec route_dave_to_call(binary(), binary(), map()) -> ok.
route_dave_to_call(<<>>, _SenderBin, _Data) ->
    logger:warning("dave message: missing channel_id", #{}),
    ok;
route_dave_to_call(ChannelIdBin, SenderBin, Data) ->
    case call_manager:lookup(call_channel_id(ChannelIdBin)) of
        {ok, CallPid} ->
            try
                gen_server:call(CallPid, {dave_message, SenderBin, Data}, 5000)
            catch
                _:_ ->
                    ok
            end;
        Other ->
            logger:warning("dave message: no call for channel", #{
                channel_id => ChannelIdBin, lookup => Other
            }),
            ok
    end.

-spec call_channel_id(binary()) -> integer() | binary().
call_channel_id(Bin) when is_binary(Bin) ->
    try
        binary_to_integer(Bin)
    catch
        _:_ -> Bin
    end.

parse_guild_id(Bin) when is_binary(Bin) ->
    try
        {ok, binary_to_integer(Bin)}
    catch
        _:_ -> error
    end;
parse_guild_id(Int) when is_integer(Int) ->
    {ok, Int};
parse_guild_id(_) ->
    error.

-spec handle_voice_disconnect(session_state()) -> voice_state_reply().
handle_voice_disconnect(State) ->
    Guilds = maps:get(guilds, State),
    UserId = maps:get(user_id, State),
    SessionId = maps:get(id, State),
    ConnectionId = maps:get(connection_id, State, null),
    logger:info(
        "voice_disconnect_start: user_id=~p session_id=~p connection_id=~p guild_count=~p",
        [UserId, SessionId, ConnectionId, maps:size(Guilds)]
    ),
    Request = #{
        user_id => UserId,
        channel_id => null,
        session_id => SessionId,
        connection_id => ConnectionId,
        self_mute => false,
        self_deaf => false,
        self_video => false,
        self_stream => false,
        viewer_stream_keys => []
    },
    session_voice_dispatch:dispatch_guild_voice_disconnects(Guilds, Request),
    {reply, #{success := true}, NewState} =
        dm_voice:disconnect_voice_user(UserId, State),
    logger:info(
        "voice_disconnect_ok: user_id=~p session_id=~p",
        [UserId, SessionId]
    ),
    {reply, ok, NewState}.

-ifdef(TEST).
-include_lib("eunit/include/eunit.hrl").

init_voice_queue_test() ->
    Result = init_voice_queue(),
    ?assert(maps:is_key(voice_queue, Result)),
    ?assert(maps:is_key(voice_queue_timer, Result)),
    ?assertEqual(undefined, maps:get(voice_queue_timer, Result)),
    ?assert(queue:is_empty(maps:get(voice_queue, Result))),
    ok.

process_voice_queue_empty_test() ->
    State = #{voice_queue => queue:new()},
    Result = process_voice_queue(State),
    ?assertEqual(State, Result),
    ok.

-endif.
