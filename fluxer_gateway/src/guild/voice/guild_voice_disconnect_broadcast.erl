%% SPDX-License-Identifier: AGPL-3.0-or-later
%%
%% Disconnect bookkeeping for guild voice. Owns the recently-disconnected cache,
%% pending-connection cleanup and the DAVE room lifecycle: participants that leave
%% are driven out of their channel's MLS room, and rooms that go idle are dropped.
%% The pre-DAVE shared-key storage that used to live here is gone.

-module(guild_voice_disconnect_broadcast).
-typing([eqwalizer]).

-export([
    recently_disconnected_voice_states/1,
    cache_recently_disconnected/2,
    clear_recently_disconnected/2,
    clear_recently_disconnected_for_channel/2,
    clear_pending_voice_connection/2,
    clear_pending_voice_connections_for_user/3,
    clear_pending_voice_connections_for_user_channel/3,
    clear_pending_voice_connections_for_channel/2,
    retire_voice_states/4,
    purge_count_cache/1
]).

-export_type([
    guild_state/0,
    voice_state_map/0
]).

-define(RECENTLY_DISCONNECTED_TTL_MS, 60000).

-type guild_state() :: map().
-type voice_state_map() :: #{binary() => map()}.

-spec recently_disconnected_voice_states(guild_state()) -> map().
recently_disconnected_voice_states(State) ->
    case maps:get(recently_disconnected_voice_states, State, undefined) of
        Map when is_map(Map) -> Map;
        _ -> #{}
    end.

-spec cache_recently_disconnected(voice_state_map(), guild_state()) -> guild_state().
cache_recently_disconnected(VoiceStatesToCache, State) ->
    Now = erlang:system_time(millisecond),
    Existing = recently_disconnected_voice_states(State),
    Swept = sweep_expired_recently_disconnected(Existing, Now),
    NewEntries = maps:fold(
        fun(ConnId, VoiceState, Acc) ->
            Acc#{ConnId => #{voice_state => VoiceState, disconnected_at => Now}}
        end,
        Swept,
        VoiceStatesToCache
    ),
    State#{recently_disconnected_voice_states => NewEntries}.

-spec sweep_expired_recently_disconnected(map(), integer()) -> map().
sweep_expired_recently_disconnected(Cache, Now) ->
    maps:filter(
        fun
            (_ConnId, #{disconnected_at := DisconnectedAt}) ->
                (Now - DisconnectedAt) < ?RECENTLY_DISCONNECTED_TTL_MS;
            (_ConnId, _) ->
                false
        end,
        Cache
    ).

-spec clear_recently_disconnected(binary(), guild_state()) -> guild_state().
clear_recently_disconnected(ConnectionId, State) ->
    Cache = recently_disconnected_voice_states(State),
    State#{recently_disconnected_voice_states => maps:remove(ConnectionId, Cache)}.

-spec clear_recently_disconnected_for_channel(integer(), guild_state()) -> guild_state().
clear_recently_disconnected_for_channel(ChannelId, State) ->
    Cache = recently_disconnected_voice_states(State),
    NewCache = maps:filter(
        fun
            (_ConnId, #{voice_state := VS}) ->
                voice_state_utils:voice_state_channel_id(VS) =/= ChannelId;
            (_ConnId, _) ->
                false
        end,
        Cache
    ),
    State#{recently_disconnected_voice_states => NewCache}.

-spec clear_pending_voice_connection(binary(), guild_state()) -> guild_state().
clear_pending_voice_connection(ConnectionId, State) ->
    PendingConnections = maps:get(pending_voice_connections, State, #{}),
    State#{pending_voice_connections => maps:remove(ConnectionId, PendingConnections)}.

-spec clear_pending_voice_connections_for_user(integer(), binary() | undefined, guild_state()) ->
    guild_state().
clear_pending_voice_connections_for_user(UserId, RequestSessionId, State) ->
    PendingConnections = maps:get(pending_voice_connections, State, #{}),
    FilteredPending = maps:filter(
        fun(_ConnId, PendingData) ->
            PendingUserId = maps:get(user_id, PendingData, undefined),
            PendingUserId =/= UserId orelse
                not pending_session_matches(PendingData, RequestSessionId)
        end,
        PendingConnections
    ),
    State#{pending_voice_connections => FilteredPending}.

-spec pending_session_matches(map(), binary() | undefined) -> boolean().
pending_session_matches(_PendingData, undefined) ->
    true;
pending_session_matches(PendingData, RequestSessionId) ->
    normalize_session_id(maps:get(session_id, PendingData, undefined)) =:= RequestSessionId.

-spec normalize_session_id(term()) -> binary() | undefined.
normalize_session_id(Value) -> voice_state_utils:normalize_session_id(Value).

-spec clear_pending_voice_connections_for_user_channel(integer(), integer(), guild_state()) ->
    guild_state().
clear_pending_voice_connections_for_user_channel(UserId, ChannelId, State) ->
    PendingConnections = maps:get(pending_voice_connections, State, #{}),
    FilteredPending = maps:filter(
        fun(_ConnId, PendingData) ->
            not pending_user_channel_matches(PendingData, UserId, ChannelId)
        end,
        PendingConnections
    ),
    State#{pending_voice_connections => FilteredPending}.

-spec pending_user_channel_matches(map(), integer(), integer()) -> boolean().
pending_user_channel_matches(PendingData, UserId, ChannelId) ->
    maps:get(user_id, PendingData, undefined) =:= UserId andalso
        maps:get(channel_id, PendingData, undefined) =:= ChannelId.

-spec clear_pending_voice_connections_for_channel(integer(), guild_state()) -> guild_state().
clear_pending_voice_connections_for_channel(ChannelId, State) ->
    PendingConnections = maps:get(pending_voice_connections, State, #{}),
    FilteredPending = maps:filter(
        fun(_ConnId, PendingData) ->
            maps:get(channel_id, PendingData, undefined) =/= ChannelId
        end,
        PendingConnections
    ),
    State#{pending_voice_connections => FilteredPending}.

%% --------------------------------------------------------------------------
%% DAVE room lifecycle.
%% --------------------------------------------------------------------------

%% Take disconnected participants out of their DAVE rooms: drive `member_left'
%% per removed voice state so the MLS group commits the removal, then forget any
%% of the affected channels' rooms that no longer has a live voice state or a
%% pending join. Guarded so a DAVE error never affects disconnect bookkeeping.
-spec retire_voice_states([integer()], voice_state_map(), voice_state_map(), guild_state()) ->
    guild_state().
retire_voice_states(Channels, RemovedVoiceStates, RemainingVoiceStates, State) ->
    WithLeft = maps:fold(
        fun(ConnId, VoiceState, AccState) ->
            dave_member_left(VoiceState, ConnId, AccState)
        end,
        State,
        RemovedVoiceStates
    ),
    lists:foldl(
        fun(ChId, Acc) -> drop_dave_room_if_idle(ChId, RemainingVoiceStates, Acc) end,
        WithLeft,
        lists:usort(Channels)
    ).

%% Drop the channel's DAVE room once nothing is left that could participate:
%% no live voice state and no pending join in that channel.
-spec drop_dave_room_if_idle(integer() | undefined, voice_state_map(), guild_state()) ->
    guild_state().
drop_dave_room_if_idle(ChannelId, VoiceStates, State) when is_integer(ChannelId) ->
    case channel_has_participants(ChannelId, VoiceStates, State) of
        true ->
            State;
        false ->
            ChIdBin = integer_to_binary(ChannelId),
            Rooms = maps:get(dave_rooms, State, #{}),
            State#{dave_rooms => maps:remove(ChIdBin, Rooms)}
    end;
drop_dave_room_if_idle(_ChannelId, _VoiceStates, State) ->
    State.

-spec channel_has_participants(integer(), voice_state_map(), guild_state()) -> boolean().
channel_has_participants(ChannelId, VoiceStates, State) ->
    HasLive = maps:fold(
        fun(_ConnId, VoiceState, Acc) ->
            Acc orelse voice_state_utils:voice_state_channel_id(VoiceState) =:= ChannelId
        end,
        false,
        VoiceStates
    ),
    HasLive orelse
        maps:fold(
            fun(_ConnId, PendingData, Acc) ->
                Acc orelse maps:get(channel_id, PendingData, undefined) =:= ChannelId
            end,
            false,
            maps:get(pending_voice_connections, State, #{})
        ).

%% Additive to dave_rooms only; guarded so a DAVE error never affects the
%% disconnect itself.
dave_member_left(VoiceState, ConnId, State) ->
    ChId = voice_state_utils:voice_state_channel_id(VoiceState),
    UserId = voice_state_utils:voice_state_user_id(VoiceState),
    case {is_integer(ChId), is_integer(UserId)} of
        {true, true} ->
            ChIdBin = integer_to_binary(ChId),
            UserBin = integer_to_binary(UserId),
            Rooms = maps:get(dave_rooms, State, #{}),
            case maps:get(ChIdBin, Rooms, undefined) of
                undefined ->
                    State;
                RS ->
                    try guild_voice_dave:drive_member_left(ChIdBin, UserBin, ConnId, RS) of
                        NewRS -> State#{dave_rooms => Rooms#{ChIdBin => NewRS}}
                    catch
                        _:_ ->
                            State
                    end
            end;
        _ ->
            State
    end.

-spec purge_count_cache([binary()]) -> ok.
purge_count_cache(ConnectionIds) ->
    lists:foreach(fun voice_state_counts_cache:remove_connection/1, ConnectionIds),
    ok.
