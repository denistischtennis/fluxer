%% SPDX-License-Identifier: AGPL-3.0-or-later

-module(guild_voice_connection_move).

-typing([eqwalizer]).

-include_lib("fluxer_gateway/include/voice_state.hrl").
-include_lib("kernel/include/logger.hrl").


-export([handle_client_channel_move/6]).

-export_type([
    guild_state/0,
    voice_state/0,
    voice_state_map/0,
    context/0
]).

-type guild_state() :: map().
-type voice_state() :: map().
-type voice_state_map() :: #{binary() => voice_state()}.
-type context() :: guild_voice_connection_util:context().

-spec handle_client_channel_move(
    context(), integer(), map(), binary(), voice_state_map(), guild_state()
) -> {reply, map(), guild_state()} | {reply, {error, atom(), atom()}, guild_state()}.
handle_client_channel_move(Context, ChannelIdValue, Member, ConnectionId, VoiceStates, State) ->
    UserId = maps:get(user_id, Context),
    SessionId = maps:get(session_id, Context),
    ExistingVoiceState = maps:get(ConnectionId, VoiceStates),
    State0 = mark_move_flags(UserId, ChannelIdValue, State),
    request_move_token(Context, ChannelIdValue, Member, SessionId, #{
        state => State0,
        old_connection_id => ConnectionId,
        existing_voice_state => ExistingVoiceState,
        voice_states => VoiceStates
    }).

-spec mark_move_flags(integer(), integer(), guild_state()) -> guild_state().
mark_move_flags(UserId, ChannelIdValue, State) ->
    guild_virtual_channel_access:mark_transition_flags(UserId, ChannelIdValue, State).

-spec clear_move_flags(integer(), integer(), guild_state()) -> guild_state().
clear_move_flags(UserId, ChannelIdValue, State) ->
    guild_virtual_channel_access:clear_transition_flags(UserId, ChannelIdValue, State).

-spec request_move_token(context(), integer(), map(), term(), map()) ->
    {reply, map(), guild_state()} | {reply, {error, atom(), atom()}, guild_state()}.
request_move_token(Context, ChannelIdValue, Member, SessionId, MoveState) ->
    State = maps:get(state, MoveState),
    case guild_voice_connection_util:resolve_guild_identity(State) of
        {error, ErrorAtom} ->
            UserId = maps:get(user_id, Context),
            {reply, gateway_errors:error(ErrorAtom),
                clear_move_flags(UserId, ChannelIdValue, State)};
        {ok, GuildId, _GuildIdBin} ->
            do_request_move_token(
                Context, ChannelIdValue, Member, SessionId, MoveState, GuildId
            )
    end.

-spec do_request_move_token(context(), integer(), map(), term(), map(), integer()) ->
    {reply, map(), guild_state()} | {reply, {error, atom(), atom()}, guild_state()}.
do_request_move_token(Context, ChannelIdValue, Member, SessionId, MoveState, GuildId) ->
    State = maps:get(state, MoveState),
    UserId = maps:get(user_id, Context),
    ConnId = maps:get(connection_id, Context),
    VoicePerms = voice_utils:compute_voice_permissions(UserId, ChannelIdValue, State),
    TokenNonce = voice_utils:generate_token_nonce(),
    Lat = maps:get(latitude, Context, undefined),
    Lng = maps:get(longitude, Context, undefined),
    TokenResult = guild_voice_connection_token:request_voice_token(
        GuildId, ChannelIdValue, UserId, ConnId, VoicePerms, TokenNonce, Lat, Lng
    ),
    handle_move_token_result(TokenResult, #{
        context => Context,
        channel_id => ChannelIdValue,
        member => Member,
        session_id => SessionId,
        state => State,
        old_connection_id => maps:get(old_connection_id, MoveState),
        existing_voice_state => maps:get(existing_voice_state, MoveState),
        voice_states => maps:get(voice_states, MoveState),
        guild_id => GuildId,
        voice_permissions => VoicePerms,
        token_nonce => TokenNonce,
        latitude => Lat,
        longitude => Lng
    }).

-spec handle_move_token_result(
    {ok, map()} | {error, term()}, map()
) -> {reply, map(), guild_state()} | {reply, {error, atom(), atom()}, guild_state()}.
handle_move_token_result({ok, TokenData}, Build) ->
    build_move_result(Build#{token_data => TokenData});
handle_move_token_result({error, _Reason}, Build) ->
    #{state := State, context := Context, channel_id := ChannelIdValue} = Build,
    UserId = maps:get(user_id, Context),
    {reply, gateway_errors:error(voice_token_failed),
        clear_move_flags(UserId, ChannelIdValue, State)}.

-spec build_move_result(
    map()
) -> {reply, map(), guild_state()}.
build_move_result(Build) ->
    Context = maps:get(context, Build),
    ChannelIdValue = maps:get(channel_id, Build),
    TokenData = maps:get(token_data, Build),
    Token = maps:get(token, TokenData),
    Endpoint = maps:get(endpoint, TokenData),
    NewConnectionId = maps:get(connection_id, TokenData),
    State1 = disconnect_old_connection(Build),
    State1Cleaned = cleanup_stale_virtual_access(Build, State1),
    MoveBuild = move_build_fields(Build),
    VoiceState = build_move_voice_state(MoveBuild#{connection_id => NewConnectionId}),
    PendingMetadata = build_move_pending(MoveBuild#{
        connection_id => NewConnectionId,
        voice_state => VoiceState
    }),
    State2 = guild_voice_connection_pending:store_pending(
        NewConnectionId, PendingMetadata, State1Cleaned
    ),
    DaveEnabled = guild_voice_e2ee:context_e2ee_capable_guild(Context, State2),
    Negotiation =
        case DaveEnabled of
            true ->
                guild_voice_dave:negotiate_join(
                    integer_to_binary(maps:get(user_id, Context)),
                    maps:get(dave_max_version, Context, 1),
                    guild_voice_connection_util:snowflake_bin(ChannelIdValue),
                    State2
                );
            false ->
                {ok, null, State2}
        end,
    case Negotiation of
        {ok, DaveVersion, State3} ->
            MoveReply = #{
                success => true,
                needs_token => true,
                token => Token,
                endpoint => Endpoint,
                connection_id => NewConnectionId,
                dave_version => DaveVersion,
                voice_state => voice_state_utils:external_voice_state(VoiceState)
            },
            {reply, MoveReply, State3};
        {error, Reason, State3} ->
            %% Same fail-closed rule as fresh joins: never hand out a move into an
            %% E2EE-active channel without a negotiated DAVE room.
            ChInt = to_channel_int(ChannelIdValue),
            VoiceStates = maps:get(voice_states, State3, #{}),
            case guild_voice_e2ee:channel_is_e2ee_active(ChInt, VoiceStates) of
                true ->
                    ?LOG_WARNING("dave move negotiation failed in e2ee-active channel; refusing move", #{
                        channel_id => ChInt, reason => Reason
                    }),
                    {reply, gateway_errors:error(voice_e2ee_required), State3};
                false ->
                    ?LOG_WARNING("dave move negotiation failed; moving without dave", #{
                        channel_id => ChInt, reason => Reason
                    }),
                    MoveReply = #{
                        success => true,
                        needs_token => true,
                        token => Token,
                        endpoint => Endpoint,
                        connection_id => NewConnectionId,
                        dave_version => null,
                        voice_state => voice_state_utils:external_voice_state(VoiceState)
                    },
                    {reply, MoveReply, State3}
            end
    end.

-spec to_channel_int(integer() | binary()) -> integer().
to_channel_int(V) when is_integer(V) -> V;
to_channel_int(V) when is_binary(V) -> binary_to_integer(V).

-spec cleanup_stale_virtual_access(map(), guild_state()) -> guild_state().
cleanup_stale_virtual_access(Build, State) ->
    Context = maps:get(context, Build),
    UserId = maps:get(user_id, Context),
    guild_voice_disconnect_user:cleanup_virtual_channel_access_for_user(UserId, State).

-spec disconnect_old_connection(map()) -> guild_state().
disconnect_old_connection(Build) ->
    State = maps:get(state, Build),
    OldConnectionId = maps:get(old_connection_id, Build),
    ExistingVoiceState = maps:get(existing_voice_state, Build),
    VoiceStates = maps:get(voice_states, Build),
    OldChannelIdBin = maps:get(<<"channel_id">>, ExistingVoiceState, null),
    NewVoiceStates = maps:remove(OldConnectionId, VoiceStates),
    State1 = guild_voice_disconnect_broadcast:retire_voice_states(
        [voice_state_utils:voice_state_channel_id(ExistingVoiceState)],
        #{OldConnectionId => ExistingVoiceState},
        NewVoiceStates,
        State#{voice_states => NewVoiceStates}
    ),
    DisconnectVS = ExistingVoiceState#{<<"channel_id">> => null},
    guild_voice_broadcast:broadcast_voice_state_update(DisconnectVS, State1, OldChannelIdBin),
    State1.

-spec move_build_fields(map()) -> map().
move_build_fields(Build) ->
    Context = maps:get(context, Build),
    Member = maps:get(member, Build),
    VoicePermissions = maps:get(voice_permissions, Build),
    UserId = maps:get(user_id, Context),
    ChannelIdValue = maps:get(channel_id, Build),
    #{
        user_id => UserId,
        guild_id => maps:get(guild_id, Build),
        guild_id_bin => integer_to_binary(maps:get(guild_id, Build)),
        channel_id => ChannelIdValue,
        channel_id_bin => integer_to_binary(ChannelIdValue),
        user_id_bin => integer_to_binary(UserId),
        session_id => guild_voice_connection_util:normalize_session_id(
            maps:get(session_id, Build)
        ),
        flags => guild_voice_connection_util:voice_flags_for_permissions(
            Context, VoicePermissions
        ),
        server_mute => maps:get(<<"mute">>, Member, false),
        server_deaf => maps:get(<<"deaf">>, Member, false),
        member => Member,
        latitude => maps:get(latitude, Build),
        longitude => maps:get(longitude, Build),
        e2ee_capable => move_e2ee_capable(Context, maps:get(state, Build)),
        token_data => maps:get(token_data, Build),
        token_nonce => maps:get(token_nonce, Build)
    }.

-spec move_e2ee_capable(context(), guild_state()) -> boolean().
move_e2ee_capable(Context, State) ->
    guild_voice_e2ee:context_e2ee_capable_guild(Context, State).

-spec build_move_voice_state(map()) -> voice_state().
build_move_voice_state(Build) ->
    TokenData = maps:get(token_data, Build),
    VS0 = guild_voice_state:create_voice_state(
        #{
            guild_id => maps:get(guild_id_bin, Build),
            channel_id => maps:get(channel_id_bin, Build),
            user_id => maps:get(user_id_bin, Build),
            connection_id => maps:get(connection_id, Build),
            server_mute => maps:get(server_mute, Build),
            server_deaf => maps:get(server_deaf, Build),
            viewer_stream_keys => [],
            e2ee_capable => maps:get(e2ee_capable, Build)
        },
        maps:get(flags, Build)
    ),
    VS1 = guild_voice_connection_util:maybe_attach_voice_routing_metadata(
        VS0,
        maps:get(region_id, TokenData, undefined),
        maps:get(server_id, TokenData, undefined)
    ),
    VS2 = guild_voice_connection_util:maybe_attach_geolocation(
        VS1, maps:get(latitude, Build), maps:get(longitude, Build)
    ),
    VS3 = guild_voice_connection_util:maybe_attach_session_id(VS2, maps:get(session_id, Build)),
    guild_voice_connection_util:maybe_attach_member(VS3, maps:get(member, Build)).

-spec build_move_pending(map()) -> map().
build_move_pending(Build) ->
    Now = erlang:system_time(millisecond),
    Flags = maps:get(flags, Build),
    #{
        user_id => maps:get(user_id, Build),
        guild_id => maps:get(guild_id, Build),
        channel_id => maps:get(channel_id, Build),
        session_id => maps:get(session_id, Build),
        self_mute => maps:get(self_mute, Flags),
        self_deaf => maps:get(self_deaf, Flags),
        self_video => maps:get(self_video, Flags),
        self_stream => maps:get(self_stream, Flags),
        is_mobile => maps:get(is_mobile, Flags),
        suppress => maps:get(suppress, Flags),
        server_mute => maps:get(server_mute, Build),
        server_deaf => maps:get(server_deaf, Build),
        member => maps:get(member, Build),
        latitude => maps:get(latitude, Build),
        longitude => maps:get(longitude, Build),
        viewer_stream_keys => [],
        e2ee_capable => maps:get(e2ee_capable, Build),
        voice_state => maps:get(voice_state, Build),
        token_nonce => maps:get(token_nonce, Build),
        created_at => Now,
        expires_at => Now + 30000
    }.
