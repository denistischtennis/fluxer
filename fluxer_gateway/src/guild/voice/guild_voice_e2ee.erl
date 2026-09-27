%% SPDX-License-Identifier: AGPL-3.0-or-later
%%
%% Voice E2EE policy gating. This module no longer holds any key material: the
%% LiveKit shared-key scheme was replaced by DAVE (MLS). Room state, epochs and
%% ratchets live in `voice_dave_coordinator' / `voice_dave_host'; this file only
%% answers "is encryption enforced here, and is this participant capable?".

-module(guild_voice_e2ee).
-typing([eqwalizer]).

-export([
    check_join_allowed_guild/4,
    check_join_allowed_dm/4,
    channel_is_e2ee_active/2,
    channel_is_e2ee_active_dm/2,
    join_downgrades_e2ee/4,
    voice_state_e2ee_capable/1,
    is_e2ee_enabled_for_guild/1,
    is_e2ee_enabled_for_dm/0,
    guild_has_voice_e2ee_feature/1,
    context_e2ee_capable_guild/2
]).

-spec voice_state_e2ee_capable(term()) -> boolean().
voice_state_e2ee_capable(VoiceState) when is_map(VoiceState) ->
    case maps:get(<<"e2ee_capable">>, VoiceState, false) of
        true -> true;
        _ -> false
    end;
voice_state_e2ee_capable(_) ->
    false.

-spec guild_has_voice_e2ee_feature(map()) -> boolean().
guild_has_voice_e2ee_feature(GuildState) when is_map(GuildState) ->
    Data = maps:get(data, GuildState, #{}),
    Guild = maps:get(<<"guild">>, Data, #{}),
    Features = maps:get(<<"features">>, Guild, []),
    is_list(Features) andalso lists:member(<<"VOICE_E2EE">>, Features);
guild_has_voice_e2ee_feature(_) ->
    false.

-spec is_e2ee_enabled_for_guild(map()) -> boolean().
is_e2ee_enabled_for_guild(GuildState) ->
    case gateway_rollout_config:voice_e2ee_scope() of
        platform_wide -> true;
        _ -> guild_has_voice_e2ee_feature(GuildState)
    end.

-spec is_e2ee_enabled_for_dm() -> boolean().
is_e2ee_enabled_for_dm() ->
    gateway_rollout_config:voice_e2ee_scope() =:= platform_wide.

-spec context_e2ee_capable_guild(map(), map()) -> boolean().
context_e2ee_capable_guild(Context, GuildState) ->
    maps:get(e2ee_capable, Context, false) andalso is_e2ee_enabled_for_guild(GuildState).

-spec channel_is_e2ee_active(integer(), map()) -> boolean().
channel_is_e2ee_active(ChannelId, VoiceStates) when is_map(VoiceStates) ->
    ChannelIdBin = integer_to_binary(ChannelId),
    {Count, AllCapable} = maps:fold(
        fun(_ConnId, VoiceState, {Acc, AllCap}) ->
            update_e2ee_channel_count(VoiceState, ChannelIdBin, Acc, AllCap)
        end,
        {0, true},
        VoiceStates
    ),
    Count > 0 andalso AllCapable;
channel_is_e2ee_active(_, _) ->
    false.

-spec update_e2ee_channel_count(map(), binary(), non_neg_integer(), boolean()) ->
    {non_neg_integer(), boolean()}.
update_e2ee_channel_count(VoiceState, ChannelIdBin, Acc, AllCap) ->
    case maps:get(<<"channel_id">>, VoiceState, null) of
        ChannelIdBin -> {Acc + 1, AllCap andalso voice_state_e2ee_capable(VoiceState)};
        _ -> {Acc, AllCap}
    end.

-spec channel_is_e2ee_active_dm(integer(), map()) -> boolean().
channel_is_e2ee_active_dm(ChannelId, VoiceStates) ->
    channel_is_e2ee_active(ChannelId, VoiceStates).

-spec join_downgrades_e2ee(integer(), boolean(), boolean(), map()) -> boolean().
join_downgrades_e2ee(ChannelId, E2EECapable, Bot, VoiceStates) ->
    (Bot orelse not E2EECapable) andalso
        channel_is_e2ee_active(ChannelId, VoiceStates).

-spec check_join_allowed_guild(integer(), boolean(), boolean(), map()) ->
    ok | {error, atom()}.
check_join_allowed_guild(_ChannelId, _E2EECapable, true, _VoiceStates) ->
    ok;
check_join_allowed_guild(_ChannelId, true, _Bot, _VoiceStates) ->
    ok;
check_join_allowed_guild(ChannelId, false, false, VoiceStates) ->
    case channel_is_e2ee_active(ChannelId, VoiceStates) of
        true -> {error, voice_e2ee_required};
        false -> ok
    end.

-spec check_join_allowed_dm(integer(), boolean(), boolean(), map()) ->
    ok | {error, atom()}.
check_join_allowed_dm(ChannelId, E2EECapable, Bot, VoiceStates) ->
    check_join_allowed_guild(ChannelId, E2EECapable, Bot, VoiceStates).

-ifdef(TEST).
-include_lib("eunit/include/eunit.hrl").

voice_state_e2ee_capable_test() ->
    ?assert(voice_state_e2ee_capable(#{<<"e2ee_capable">> => true})),
    ?assertNot(voice_state_e2ee_capable(#{<<"e2ee_capable">> => false})),
    ?assertNot(voice_state_e2ee_capable(#{})),
    ?assertNot(voice_state_e2ee_capable(not_a_map)).

channel_is_e2ee_active_empty_test() ->
    ?assertNot(channel_is_e2ee_active(100, #{})).

channel_is_e2ee_active_all_capable_test() ->
    VoiceStates = #{
        <<"c1">> => #{<<"channel_id">> => <<"100">>, <<"e2ee_capable">> => true},
        <<"c2">> => #{<<"channel_id">> => <<"100">>, <<"e2ee_capable">> => true}
    },
    ?assert(channel_is_e2ee_active(100, VoiceStates)).

channel_is_e2ee_active_mixed_test() ->
    VoiceStates = #{
        <<"c1">> => #{<<"channel_id">> => <<"100">>, <<"e2ee_capable">> => true},
        <<"c2">> => #{<<"channel_id">> => <<"100">>, <<"e2ee_capable">> => false}
    },
    ?assertNot(channel_is_e2ee_active(100, VoiceStates)).

channel_is_e2ee_active_ignores_other_channels_test() ->
    VoiceStates = #{
        <<"c1">> => #{<<"channel_id">> => <<"100">>, <<"e2ee_capable">> => true},
        <<"c2">> => #{<<"channel_id">> => <<"200">>, <<"e2ee_capable">> => false}
    },
    ?assert(channel_is_e2ee_active(100, VoiceStates)).

check_join_allowed_guild_empty_test() ->
    ?assertEqual(ok, check_join_allowed_guild(100, false, false, #{})).

check_join_allowed_guild_blocked_test() ->
    VoiceStates = #{
        <<"c1">> => #{<<"channel_id">> => <<"100">>, <<"e2ee_capable">> => true}
    },
    ?assertEqual(
        {error, voice_e2ee_required},
        check_join_allowed_guild(100, false, false, VoiceStates)
    ).

check_join_allowed_guild_bot_breaks_test() ->
    VoiceStates = #{
        <<"c1">> => #{<<"channel_id">> => <<"100">>, <<"e2ee_capable">> => true}
    },
    ?assertEqual(ok, check_join_allowed_guild(100, false, true, VoiceStates)).

check_join_allowed_guild_e2ee_join_test() ->
    VoiceStates = #{
        <<"c1">> => #{<<"channel_id">> => <<"100">>, <<"e2ee_capable">> => true}
    },
    ?assertEqual(ok, check_join_allowed_guild(100, true, false, VoiceStates)).

join_downgrades_e2ee_bot_breaks_active_channel_test() ->
    VoiceStates = #{
        <<"c1">> => #{<<"channel_id">> => <<"100">>, <<"e2ee_capable">> => true}
    },
    ?assert(join_downgrades_e2ee(100, true, true, VoiceStates)).

join_downgrades_e2ee_non_capable_breaks_active_channel_test() ->
    VoiceStates = #{
        <<"c1">> => #{<<"channel_id">> => <<"100">>, <<"e2ee_capable">> => true}
    },
    ?assert(join_downgrades_e2ee(100, false, false, VoiceStates)).

join_downgrades_e2ee_capable_join_does_not_downgrade_test() ->
    VoiceStates = #{
        <<"c1">> => #{<<"channel_id">> => <<"100">>, <<"e2ee_capable">> => true}
    },
    ?assertNot(join_downgrades_e2ee(100, true, false, VoiceStates)).

join_downgrades_e2ee_inactive_channel_does_not_downgrade_test() ->
    ?assertNot(join_downgrades_e2ee(100, false, true, #{})).

-endif.
