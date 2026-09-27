%% SPDX-License-Identifier: AGPL-3.0-or-later
%%
%% DAVE room ownership for DM calls.
%%
%% A DM call has exactly one MLS group, owned by the call gen_server (`call.erl`).
%% That process is the only serialized point for the call, which is what the DAVE
%% delivery-service model requires: ordered commits, targeted welcomes, transition
%% timers. This module keeps the room inside the call state under `dave_rooms'
%% (same shape the guild voice server uses) and delegates all protocol work to
%% `guild_voice_dave', which is generic over any state map carrying that field.
%%
%% Every entry point is guarded: a DAVE failure must never take a call down. It
%% returns the untouched state instead so the caller can decide (the token path
%% fails closed when DAVE is enforced).

-module(call_dave).
-typing([eqwalizer]).

-include_lib("kernel/include/logger.hrl").

-export([
    negotiate_join/3,
    handle_message/3,
    member_left/2,
    room/1
]).

-type call_state() :: map().
-type user_id() :: binary().

%% Read the current room, if any.
-spec room(call_state()) -> voice_dave_coordinator:room_state() | undefined.
room(State) ->
    case channel_key_safe(State) of
        {ok, ChIdBin} -> room_in(ChIdBin, State);
        error -> undefined
    end.

%% Join negotiation for a participant entering the call's voice channel.
%% Returns the negotiated protocol version (`null' when the call has no usable
%% channel id, which cannot happen for a live call but is handled defensively).
-spec negotiate_join(user_id(), non_neg_integer(), call_state()) ->
    {non_neg_integer() | null, call_state()}.
negotiate_join(UserBin, MaxVersion, State) ->
    case channel_key_safe(State) of
        {ok, ChIdBin} -> guild_voice_dave:negotiate_join(UserBin, MaxVersion, ChIdBin, State);
        error -> {null, State}
    end.

%% Drive an inbound opcode-17 message from a call participant.
-spec handle_message(map(), user_id(), call_state()) -> call_state().
handle_message(Raw, SenderBin, State) ->
    case channel_key_safe(State) of
        {ok, ChIdBin} ->
            Room = room_in(ChIdBin, State),
            Members = members_fun(Room),
            try guild_voice_dave:drive_message(ChIdBin, Raw, SenderBin, Room, Members) of
                NewRoom -> put_room(ChIdBin, NewRoom, State)
            catch
                Class:Reason ->
                    ?LOG_WARNING("call dave message failed", #{
                        channel_id => ChIdBin,
                        sender => SenderBin,
                        class => Class,
                        reason => Reason
                    }),
                    State
            end;
        error ->
            State
    end.

%% Remove a departed participant from the call's MLS group.
-spec member_left(user_id(), call_state()) -> call_state().
member_left(UserBin, State) ->
    case channel_key_safe(State) of
        {ok, ChIdBin} ->
            case room_in(ChIdBin, State) of
                undefined ->
                    State;
                Room ->
                    Members = members_fun(Room),
                    try guild_voice_dave:drive_member_left(ChIdBin, UserBin, Room, Members) of
                        NewRoom -> put_room(ChIdBin, NewRoom, State)
                    catch
                        Class:Reason ->
                            ?LOG_WARNING("call dave member_left failed", #{
                                channel_id => ChIdBin,
                                user_id => UserBin,
                                class => Class,
                                reason => Reason
                            }),
                            State
                    end
            end;
        error ->
            State
    end.

%% --------------------------------------------------------------------------
%% internals
%% --------------------------------------------------------------------------

-spec channel_key_safe(call_state()) -> {ok, binary()} | error.
channel_key_safe(State) ->
    case maps:get(channel_id, State, undefined) of
        ChId when is_integer(ChId), ChId > 0 -> {ok, integer_to_binary(ChId)};
        ChId when is_binary(ChId) andalso byte_size(ChId) > 0 -> {ok, ChId};
        _ -> error
    end.

-spec room_in(binary(), call_state()) -> voice_dave_coordinator:room_state() | undefined.
room_in(ChIdBin, State) ->
    Rooms = maps:get(dave_rooms, State, #{}),
    maps:get(ChIdBin, Rooms, undefined).

-spec put_room(binary(), voice_dave_coordinator:room_state(), call_state()) -> call_state().
put_room(ChIdBin, Room, State) ->
    Rooms = maps:get(dave_rooms, State, #{}),
    State#{dave_rooms => Rooms#{ChIdBin => Room}}.

%% Broadcast fan-out set: users that already contributed a key package.
-spec members_fun(voice_dave_coordinator:room_state() | undefined) -> fun(() -> [user_id()]).
members_fun(undefined) ->
    fun() -> [] end;
members_fun(Room) ->
    fun() -> maps:keys(maps:get(key_packages, Room, #{})) end.

-ifdef(TEST).
-include_lib("eunit/include/eunit.hrl").

channel_key_safe_accepts_integer_and_binary_channel_ids_test() ->
    ?assertEqual({ok, <<"42">>}, channel_key_safe(#{channel_id => 42})),
    ?assertEqual({ok, <<"42">>}, channel_key_safe(#{channel_id => <<"42">>})),
    ?assertEqual(error, channel_key_safe(#{channel_id => 0})),
    ?assertEqual(error, channel_key_safe(#{channel_id => <<>>})).

missing_channel_id_is_not_negotiable_test() ->
    ?assertEqual({null, #{region => x}}, negotiate_join(<<"1">>, 1, #{region => x})),
    ?assertEqual(error, channel_key_safe(#{})).

room_absent_until_first_write_test() ->
    ?assertEqual(undefined, room(#{channel_id => 7})).

%% meck's mock process can be slow to start on a cold, memory-constrained Docker
%% VM; without a larger budget EUnit cancels the test rather than reporting it.
negotiate_join_stores_room_under_the_call_channel_test_() ->
    {timeout, 180, fun negotiate_join_stores_room_impl/0}.

negotiate_join_stores_room_impl() ->
    meck:new(presence_manager, [passthrough]),
    meck:new(rpc_client, [passthrough]),
    try
        meck:expect(presence_manager, dispatch_to_user, fun(_, _, _) -> ok end),
        meck:expect(
            rpc_client,
            call,
            fun(_) -> {ok, #{<<"data">> => #{<<"sender_package_b64">> => <<"S">>}}} end
        ),
        {Version, NewState} = negotiate_join(<<"1001">>, 1, #{channel_id => 555}),
        ?assertEqual(1, Version),
        Room = room(NewState),
        ?assert(is_map(Room)),
        ?assertEqual(1, maps:get(version, Room)),
        %% the room is keyed by the call's own channel, not by anything the caller passed
        ?assert(maps:is_key(<<"555">>, maps:get(dave_rooms, NewState)))
    after
        meck:unload(rpc_client),
        meck:unload(presence_manager)
    end.

member_left_without_room_is_a_noop_test() ->
    State = #{channel_id => 777},
    ?assertEqual(State, member_left(<<"1">>, State)).

handle_message_without_channel_id_returns_state_unchanged_test() ->
    ?assertEqual(#{}, handle_message(#{<<"type">> => <<"key_package">>}, <<"1">>, #{})).

member_left_without_channel_id_returns_state_unchanged_test() ->
    ?assertEqual(#{}, member_left(<<"1">>, #{})).

-endif.
