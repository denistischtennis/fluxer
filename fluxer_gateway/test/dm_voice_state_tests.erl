%% SPDX-License-Identifier: AGPL-3.0-or-later

-module(dm_voice_state_tests).
-typing([eqwalizer]).

-include_lib("eunit/include/eunit.hrl").

disconnect_removes_voice_state_count_for_null_channel_test() ->
    Before = maps:get(
        <<"total_voice_states">>, voice_state_counts_cache:get_local_counts(), 0
    ),
    ok = voice_state_counts_cache:upsert_voice_state(#{
        <<"connection_id">> => <<"conn-null">>,
        <<"channel_id">> => <<"100">>,
        <<"region_id">> => <<"us-east">>
    }),
    VoiceState = #{
        <<"channel_id">> => null,
        <<"connection_id">> => <<"conn-null">>,
        <<"user_id">> => <<"10">>,
        <<"session_id">> => <<"sess">>
    },
    VoiceStates = #{<<"conn-null">> => VoiceState},
    State = #{
        id => <<"sess">>,
        session_pid => self(),
        channels => #{},
        dm_voice_states => VoiceStates
    },
    {reply, #{success := true}, _NewState} =
        dm_voice_state:handle_dm_disconnect(<<"conn-null">>, 10, VoiceStates, State),
    Counts = voice_state_counts_cache:get_local_counts(),
    ?assertEqual(Before, maps:get(<<"total_voice_states">>, Counts)).

validate_dm_viewer_stream_keys_accepts_many_same_channel_connections_test() ->
    VoiceStates = validation_voice_states(100, 48),
    Keys = [
        voice_state_utils:build_stream_key(undefined, 100, conn_id(Index))
     || Index <- lists:seq(1, 48)
    ],
    ?assertEqual(
        {ok, Keys}, dm_voice_state:validate_dm_viewer_stream_keys(Keys, 100, VoiceStates)
    ).

validate_dm_viewer_stream_keys_rejects_guild_scope_test() ->
    VoiceStates = validation_voice_states(100, 1),
    ?assertEqual(
        {error, voice_invalid_state},
        dm_voice_state:validate_dm_viewer_stream_keys([<<"999:100:conn-1">>], 100, VoiceStates)
    ).

validate_dm_viewer_stream_keys_rejects_cross_channel_connection_test() ->
    VoiceStates = validation_voice_states(101, 1),
    ?assertEqual(
        {error, voice_invalid_state},
        dm_voice_state:validate_dm_viewer_stream_keys([<<"dm:100:conn-1">>], 100, VoiceStates)
    ).

validate_dm_viewer_stream_keys_rejects_missing_connection_test() ->
    VoiceStates = validation_voice_states(100, 1),
    ?assertEqual(
        {error, voice_connection_not_found},
        dm_voice_state:validate_dm_viewer_stream_keys([<<"dm:100:missing">>], 100, VoiceStates)
    ).

validate_dm_viewer_stream_keys_rejects_non_binary_member_test() ->
    VoiceStates = validation_voice_states(100, 1),
    ?assertEqual(
        {error, voice_invalid_state},
        dm_voice_state:validate_dm_viewer_stream_keys([123], 100, VoiceStates)
    ).

validation_voice_states(ChannelId, Count) ->
    maps:from_list([
        {conn_id(Index), #{
            <<"connection_id">> => conn_id(Index),
            <<"channel_id">> => integer_to_binary(ChannelId),
            <<"user_id">> => integer_to_binary(1000 + Index)
        }}
     || Index <- lists:seq(1, Count)
    ]).

conn_id(Index) ->
    <<"conn-", (integer_to_binary(Index))/binary>>.
