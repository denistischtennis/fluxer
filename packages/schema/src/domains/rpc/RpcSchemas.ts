// SPDX-License-Identifier: AGPL-3.0-or-later

import {RTC_REGION_ID_MAX_LENGTH, RTC_REGION_ID_MIN_LENGTH} from '@fluxer/constants/src/LimitConstants';
import {GatewayRolloutConfigResponse} from '@fluxer/schema/src/domains/admin/GatewayRolloutSchemas';
import {PushServiceDeliveryConfigResponse} from '@fluxer/schema/src/domains/admin/PushServiceDeliverySchemas';
import {WebAuthnCredentialResponse} from '@fluxer/schema/src/domains/auth/AuthSchemas';
import {ChannelResponse, RtcRegionResponse} from '@fluxer/schema/src/domains/channel/ChannelSchemas';
import {VoiceStateResponse} from '@fluxer/schema/src/domains/gateway/GatewaySchemas';
import {GuildEmojiResponse, GuildStickerResponse} from '@fluxer/schema/src/domains/guild/GuildEmojiSchemas';
import {GuildMemberResponse} from '@fluxer/schema/src/domains/guild/GuildMemberSchemas';
import {GuildResponse} from '@fluxer/schema/src/domains/guild/GuildResponseSchemas';
import {GuildRoleResponse} from '@fluxer/schema/src/domains/guild/GuildRoleSchemas';
import {FavoriteMemeResponse} from '@fluxer/schema/src/domains/meme/MemeSchemas';
import {CustomStatusPayload} from '@fluxer/schema/src/domains/user/UserRequestSchemas';
import {
	CustomStatusResponse,
	RelationshipResponse,
	UserGuildSettingsResponse,
	UserPrivateResponse,
	UserSettingsResponse,
} from '@fluxer/schema/src/domains/user/UserResponseSchemas';
import {
	createStringType,
	SnowflakeStringType,
	SnowflakeType,
	UnsignedInt64StringType,
} from '@fluxer/schema/src/primitives/SchemaPrimitives';
import {z} from 'zod';

const RPC_USER_BATCH_MAX = 1000;

// Base64-encoded opaque DAVE MLS wire bytes (key packages, proposals, commits, welcomes).
const DaveBytesType = createStringType(1, 262144).refine(
	(value) => {
		try {
			atob(value);
			return true;
		} catch {
			return false;
		}
	},
	{message: 'value must be valid base64'},
);

export const RpcGuildCollectionType = z.enum([
	'guild',
	'roles',
	'channels',
	'emojis',
	'stickers',
	'members',
	'voice_states',
]);

export type RpcGuildCollectionType = z.infer<typeof RpcGuildCollectionType>;

const ReadStateResponse = z.object({
	id: SnowflakeStringType.describe('The channel ID for this read state'),
	mention_count: z.number().describe('Number of unread mentions in the channel'),
	last_message_id: SnowflakeStringType.nullish().describe('ID of the last read message'),
	last_pin_timestamp: z.string().nullish().describe('Timestamp of the last pinned message'),
	version: UnsignedInt64StringType.optional().describe('Read-state version for ordering updates as a decimal uint64'),
});

export const RpcRequest = z.discriminatedUnion('type', [
	z.object({
		type: z.literal('session').describe('Request type for session initialization'),
		token: createStringType().describe('Authentication token for the session'),
		version: z.literal(1).describe('RPC protocol version'),
		ip: createStringType(1, 45).optional().describe('Client IP address'),
		latitude: createStringType(1, 32).optional().describe('Client latitude for region selection'),
		longitude: createStringType(1, 32).optional().describe('Client longitude for region selection'),
	}),
	z.object({
		type: z.literal('guild_collection').describe('Request type for fetching a single guild collection chunk'),
		guild_id: SnowflakeType.describe('ID of the guild to fetch'),
		collection: RpcGuildCollectionType.describe('Guild collection to fetch'),
		limit: z.number().int().min(1).max(1000).optional().describe('Maximum number of items to return'),
		after_user_id: SnowflakeType.optional().describe('Cursor for member collection pagination'),
	}),
	z.object({
		type: z.literal('voice_state_upsert').describe('Request type for persisting a guild voice state snapshot'),
		guild_id: SnowflakeType.describe('ID of the guild for this voice state'),
		voice_state: VoiceStateResponse.describe('Voice state payload to persist'),
	}),
	z.object({
		type: z.literal('voice_state_remove').describe('Request type for deleting a guild voice state snapshot'),
		guild_id: SnowflakeType.describe('ID of the guild for this voice state'),
		connection_id: createStringType(1, 255).describe('Connection ID to remove from the snapshot'),
	}),
	z.object({
		type: z.literal('log_guild_crash').describe('Request type for logging guild crashes'),
		guild_id: SnowflakeType.describe('ID of the guild that crashed'),
		stacktrace: z.string().describe('Error stacktrace from the crash'),
	}),
	z.object({
		type: z.literal('get_user_guild_settings').describe('Request type for fetching user guild settings'),
		user_ids: z.array(SnowflakeType).max(RPC_USER_BATCH_MAX).describe('IDs of users to fetch settings for'),
		guild_id: SnowflakeType.describe('ID of the guild'),
	}),
	z.object({
		type: z.literal('get_push_subscriptions').describe('Request type for fetching push notification subscriptions'),
		user_ids: z.array(SnowflakeType).describe('IDs of users to fetch subscriptions for'),
	}),
	z.object({
		type: z.literal('get_badge_counts').describe('Request type for fetching notification badge counts'),
		user_ids: z.array(SnowflakeType).describe('IDs of users to fetch badge counts for'),
	}),
	z.object({
		type: z.literal('geoip_lookup').describe('Request type for IP geolocation lookup'),
		ip: createStringType(1, 45).describe('IP address to lookup'),
	}),
	z.object({
		type: z.literal('delete_push_subscriptions').describe('Request type for deleting push notification subscriptions'),
		subscriptions: z
			.array(
				z.object({
					user_id: SnowflakeType.describe('ID of the user'),
					subscription_id: createStringType().describe('ID of the subscription to delete'),
				}),
			)
			.describe('List of subscriptions to delete'),
	}),
	z.object({
		type: z
			.literal('send_apns_push')
			.describe('Request type for sending an APNs notification through the API HTTP/2 client'),
		user_id: SnowflakeType.describe('ID of the user receiving the notification'),
		subscription_id: createStringType().describe('ID of the APNs subscription to report back to the gateway'),
		device_token: createStringType(1, 4096).describe('APNs device token'),
		app_id: createStringType(1, 128).describe('Client app channel or bundle mapping identifier'),
		provider_environment: z.enum(['production', 'development']).describe('APNs provider environment'),
		payload: z.record(z.string(), z.unknown()).describe('Notification payload built by the gateway'),
	}),
	z.object({
		type: z.literal('get_user_blocked_ids').describe('Request type for fetching blocked user IDs'),
		user_ids: z.array(SnowflakeType).max(RPC_USER_BATCH_MAX).describe('IDs of users to fetch blocked lists for'),
	}),
	z.object({
		type: z.literal('voice_get_token').describe('Request type for getting voice connection token'),
		guild_id: SnowflakeType.optional().describe('ID of the guild for the voice channel'),
		channel_id: SnowflakeType.describe('ID of the voice channel'),
		user_id: SnowflakeType.describe('ID of the user joining voice'),
		connection_id: createStringType().optional().describe('Existing connection ID for reconnection'),
		rtc_region: createStringType(RTC_REGION_ID_MIN_LENGTH, RTC_REGION_ID_MAX_LENGTH)
			.optional()
			.describe(
				`Preferred voice region for the connection (${RTC_REGION_ID_MIN_LENGTH}-${RTC_REGION_ID_MAX_LENGTH} characters)`,
			),
		latitude: createStringType(1, 32).optional().describe('Client latitude for region selection'),
		longitude: createStringType(1, 32).optional().describe('Client longitude for region selection'),
		can_speak: z.boolean().optional().describe('Whether the user can speak in the channel'),
		can_stream: z.boolean().optional().describe('Whether the user can stream in the channel'),
		can_video: z.boolean().optional().describe('Whether the user can use video in the channel'),
		token_nonce: createStringType(1, 64).optional().describe('Token nonce for replay prevention'),
	}),
	z.object({
		type: z.literal('kick_temporary_member').describe('Request type for kicking temporary guild members'),
		user_id: SnowflakeType.describe('ID of the user to kick'),
		guild_ids: z.array(SnowflakeType).describe('IDs of guilds to kick the user from'),
	}),
	z.object({
		type: z
			.literal('voice_force_disconnect_participant')
			.describe('Request type for force disconnecting a voice participant'),
		guild_id: SnowflakeType.optional().describe('ID of the guild'),
		channel_id: SnowflakeType.describe('ID of the voice channel'),
		user_id: SnowflakeType.describe('ID of the user to disconnect'),
		connection_id: createStringType().describe('Connection ID of the user'),
	}),
	z.object({
		type: z.literal('voice_update_participant').describe('Request type for updating voice participant state'),
		guild_id: SnowflakeType.optional().describe('ID of the guild'),
		channel_id: SnowflakeType.describe('ID of the voice channel'),
		user_id: SnowflakeType.describe('ID of the user to update'),
		mute: z.boolean().describe('Whether the user is muted'),
		deaf: z.boolean().describe('Whether the user is deafened'),
		can_speak: z.boolean().optional().describe('Whether the user can speak'),
		can_stream: z.boolean().optional().describe('Whether the user can stream'),
		can_video: z.boolean().optional().describe('Whether the user can use video'),
	}),
	z.object({
		type: z
			.literal('voice_force_disconnect_channel')
			.describe('Request type for force disconnecting all participants from a channel'),
		guild_id: SnowflakeType.optional().describe('ID of the guild'),
		channel_id: SnowflakeType.describe('ID of the voice channel to clear'),
	}),
	z.object({
		type: z.literal('voice_list_participants').describe('Request type for listing voice participants on one server'),
		guild_id: SnowflakeType.optional().describe('ID of the guild'),
		channel_id: SnowflakeType.describe('ID of the voice channel'),
		region_id: createStringType(1, 64).describe('Voice region that hosts the room'),
		server_id: createStringType(1, 128).describe('Voice server that hosts the room'),
	}),
	z.object({
		type: z
			.literal('voice_update_participant_permissions')
			.describe('Request type for updating voice participant permissions'),
		guild_id: SnowflakeType.optional().describe('ID of the guild'),
		channel_id: SnowflakeType.describe('ID of the voice channel'),
		user_id: SnowflakeType.describe('ID of the user to update'),
		connection_id: createStringType().describe('Connection ID of the user'),
		can_speak: z.boolean().describe('Whether the user can speak'),
		can_stream: z.boolean().describe('Whether the user can stream'),
		can_video: z.boolean().describe('Whether the user can use video'),
		deaf: z.boolean().optional().describe('Whether the user is deafened'),
	}),
	z.object({
		type: z.literal('call_ended').describe('Request type for notifying that a call has ended'),
		channel_id: SnowflakeType.describe('ID of the channel where the call ended'),
		message_id: SnowflakeType.describe('ID of the call start message'),
		participants: z.array(SnowflakeType).describe('IDs of users who participated in the call'),
		ended_timestamp: z.number().describe('Unix timestamp when the call ended'),
	}),
	z.object({
		type: z.literal('get_dm_channel').describe('Request type for fetching a DM channel'),
		channel_id: SnowflakeType.describe('ID of the DM channel'),
		user_id: SnowflakeType.describe('ID of the user requesting the channel'),
	}),
	z.object({
		type: z.literal('validate_custom_status').describe('Request type for validating a custom status'),
		user_id: SnowflakeType.describe('ID of the user'),
		custom_status: CustomStatusPayload.nullish().describe('Custom status data to validate'),
	}),
	z.object({
		type: z.literal('get_gateway_rollout_config').describe('Request type for fetching gateway rollout configuration'),
	}),
	z.object({
		type: z
			.literal('get_push_service_delivery_config')
			.describe('Request type for fetching push service delivery configuration'),
	}),
	z.object({
		type: z.literal('dave_sender_package').describe('Request type for fetching the deployment DAVE external sender package'),
	}),
	z.object({
		type: z.literal('dave_validate_key_package').describe('Request type for validating a DAVE MLS key package against a claimed user'),
		key_package_b64: DaveBytesType.describe('Base64-encoded MLS KeyPackage bytes'),
		user_id: SnowflakeType.describe('User ID the key package is claimed to belong to'),
	}),
	z.object({
		type: z.literal('dave_create_proposals').describe('Request type for creating signed DAVE external add/remove proposals'),
		group_id: SnowflakeType.describe('DAVE group (voice channel) ID'),
		epoch: z.number().int().min(0).describe('Current MLS epoch the proposals target'),
		add_b64: z.array(DaveBytesType).max(RPC_USER_BATCH_MAX).optional().describe('Base64 MLS key packages to add'),
		remove_indices: z.array(z.number().int().min(0)).max(RPC_USER_BATCH_MAX).optional().describe('Leaf indices to remove'),
	}),
	z.object({
		type: z.literal('dave_parse_commit').describe('Request type for parsing a DAVE commit/welcome bundle and deriving the roster'),
		group_id: SnowflakeType.describe('DAVE group (voice channel) ID'),
		expected_epoch: z.number().int().min(0).describe('Epoch the commit is expected to advance from'),
		committer_user_id: SnowflakeType.describe('User ID asserted as the committer by the gateway'),
		commit_welcome_b64: DaveBytesType.describe('Base64 commit(+welcome) bundle from the client'),
		pending_proposals_b64: DaveBytesType.describe('Base64 proposal bundle the DS previously issued for this transition'),
		known_roster: z
			.array(
				z.object({
					user_id: SnowflakeType.describe('Roster member user ID'),
					leaf_index: z.number().int().min(0).describe('Roster member leaf index'),
				}),
			)
			.max(RPC_USER_BATCH_MAX)
			.describe('Pre-commit occupancy'),
	}),
]);

export type RpcRequest = z.infer<typeof RpcRequest>;

const GuildReadyResponse = z.object({
	id: SnowflakeStringType.describe('Guild ID for the gateway to hydrate from its in-memory guild state'),
});

export interface RpcTimingNode {
	duration_us: number;
	count?: number;
	min_us?: number;
	max_us?: number;
	steps?: Record<string, RpcTimingNode>;
}

export const RpcTimingNode: z.ZodType<RpcTimingNode> = z.lazy(() =>
	z.object({
		duration_us: z.number().int().min(0).describe('Elapsed time in microseconds'),
		count: z.number().int().min(1).optional().describe('Number of repeated operations aggregated into this node'),
		min_us: z.number().int().min(0).optional().describe('Shortest aggregated operation duration in microseconds'),
		max_us: z.number().int().min(0).optional().describe('Longest aggregated operation duration in microseconds'),
		steps: z.record(z.string(), RpcTimingNode).optional().describe('Nested timings keyed by measured step name'),
	}),
);

const RpcTimingRuntimeNode = z.object({
	operation: z.string().optional().describe('Logical operation or routing target that touched this runtime node'),
	pod_name: z.string().optional().describe('Kubernetes pod name for this runtime node'),
});

type RpcTimingRuntimeNode = z.infer<typeof RpcTimingRuntimeNode>;

interface RpcTimingTraceSpan {
	name: string;
	duration_us: number;
	remote?: RpcTimingRuntimeNode;
	children?: Array<RpcTimingTraceSpan>;
}

const RpcTimingTraceSpan: z.ZodType<RpcTimingTraceSpan> = z.lazy(() =>
	z.object({
		name: z.string().describe('Function or operation name measured by this span'),
		duration_us: z.number().int().min(0).describe('Elapsed time in microseconds'),
		remote: RpcTimingRuntimeNode.optional().describe('Remote runtime hit by this span, when applicable'),
		children: z.array(RpcTimingTraceSpan).optional().describe('Nested spans in call order'),
	}),
);

export const RpcSessionTimings = z.object({
	unit: z.literal('microseconds').describe('Timing unit for every duration in this object'),
	total_us: z.number().int().min(0).describe('Total session initialization duration in microseconds'),
	pod_name: z.string().optional().describe('Kubernetes pod name for the runtime that produced these timings'),
	nodes: z.array(RpcTimingRuntimeNode).optional().describe('Runtime nodes hit while producing these timings'),
	trace: z.array(RpcTimingTraceSpan).optional().describe('Ordered function trace for gateway-side timings'),
	steps: z
		.record(z.string(), RpcTimingNode)
		.optional()
		.describe('Session initialization timings keyed by measured step name'),
});

export type RpcSessionTimings = z.infer<typeof RpcSessionTimings>;

export const RpcResponseSessionData = z.object({
	_timings: RpcSessionTimings.optional().describe(
		'Structured server-side timings for this session initialization, sent to staff sessions only',
	),
	_timings_gw: RpcSessionTimings.optional().describe(
		'Structured gateway-side timings for this session initialization, sent to staff sessions only',
	),
	auth_session_id_hash: z.string().nullish().describe('Hash of the authentication session ID'),
	user: UserPrivateResponse.describe('Private user data for the authenticated user'),
	user_settings: UserSettingsResponse.nullish().describe('User settings configuration'),
	user_guild_settings: z.array(UserGuildSettingsResponse).describe('Per-guild settings for the user'),
	notes: z.record(SnowflakeStringType, z.string()).describe('User notes keyed by user ID'),
	read_states: z.array(ReadStateResponse).describe('Read state for each channel'),
	private_channels: z.array(ChannelResponse).describe('List of DM and group DM channels'),
	relationships: z.array(RelationshipResponse).describe('User relationships (friends, blocked, etc.)'),
	favorite_memes: z.array(FavoriteMemeResponse).describe('List of user favorite memes'),
	guilds: z.array(GuildReadyResponse).describe('Guilds the user is a member of'),
	pinned_dms: z.array(SnowflakeStringType).describe('IDs of pinned DM channels'),
	country_code: z.string().describe('Two-letter country code from IP geolocation'),
	latitude: createStringType(1, 32).optional().describe('Latitude from IP geolocation'),
	longitude: createStringType(1, 32).optional().describe('Longitude from IP geolocation'),
	rtc_regions: z.array(RtcRegionResponse).describe('Available voice server regions'),
	webauthn_credentials: z
		.array(WebAuthnCredentialResponse)
		.describe('Registered WebAuthn credentials (passkeys) for the authenticated user'),
	version: z.number().int().describe('Session data version for cache invalidation'),
});

export type RpcResponseSessionData = z.infer<typeof RpcResponseSessionData>;

export const RpcResponseGuildCollectionData = z.object({
	collection: RpcGuildCollectionType.describe('Guild collection returned in this response'),
	guild: GuildResponse.nullish().describe('Guild information'),
	roles: z.array(GuildRoleResponse).nullish().describe('List of roles in the guild'),
	channels: z.array(ChannelResponse).nullish().describe('List of channels in the guild'),
	emojis: z.array(GuildEmojiResponse).nullish().describe('List of custom emojis in the guild'),
	stickers: z.array(GuildStickerResponse).nullish().describe('List of custom stickers in the guild'),
	members: z.array(GuildMemberResponse).nullish().describe('List of guild members in this chunk'),
	voice_states: z.array(VoiceStateResponse).nullish().describe('List of guild voice states in this chunk'),
	has_more: z.boolean().describe('Whether more data is available for this collection'),
	next_after_user_id: SnowflakeStringType.nullish().describe('Cursor for the next member chunk'),
});

export type RpcResponseGuildCollectionData = z.infer<typeof RpcResponseGuildCollectionData>;

const RpcResponseValidateCustomStatus = z.object({
	custom_status: CustomStatusResponse.nullish().describe('Validated custom status or null if invalid'),
});

export const RpcResponse = z.discriminatedUnion('type', [
	z.object({
		type: z.literal('session').describe('Response type for session initialization'),
		data: RpcResponseSessionData.describe('Session initialization data'),
	}),
	z.object({
		type: z.literal('log_guild_crash').describe('Response type for guild crash logging'),
		data: z
			.object({
				success: z.boolean().describe('Whether the crash was logged successfully'),
			})
			.describe('Crash logging result'),
	}),
	z.object({
		type: z.literal('guild_collection').describe('Response type for guild collection chunks'),
		data: RpcResponseGuildCollectionData.describe('Guild collection chunk data'),
	}),
	z.object({
		type: z.literal('voice_state_upsert').describe('Response type for voice state persistence upsert'),
		data: z.object({success: z.boolean().describe('Whether the voice state was persisted')}),
	}),
	z.object({
		type: z.literal('voice_state_remove').describe('Response type for voice state persistence removal'),
		data: z.object({success: z.boolean().describe('Whether the voice state was removed')}),
	}),
	z.object({
		type: z.literal('get_user_guild_settings').describe('Response type for user guild settings'),
		data: z
			.object({
				user_guild_settings: z
					.array(UserGuildSettingsResponse.nullable())
					.describe('Guild settings for each requested user'),
			})
			.describe('User guild settings data'),
	}),
	z.object({
		type: z.literal('get_push_subscriptions').describe('Response type for push subscriptions'),
		data: z
			.record(
				SnowflakeStringType,
				z.array(
					z.object({
						subscription_id: z.string().describe('Unique identifier for the subscription'),
						endpoint: z.string().describe('Push notification endpoint URL'),
						p256dh_key: z.string().nullable().describe('P-256 Diffie-Hellman public key'),
						auth_key: z.string().nullable().describe('Authentication secret key'),
						platform: z.string().describe('Push provider platform for this subscription'),
						app_id: z.string().nullable().describe('Client app channel or bundle mapping identifier'),
						provider_environment: z.string().nullable().describe('Push provider environment'),
					}),
				),
			)
			.describe('Push subscriptions keyed by user ID'),
	}),
	z.object({
		type: z.literal('delete_push_subscriptions').describe('Response type for push subscription deletion'),
		data: z.object({success: z.boolean().describe('Whether the deletion was successful')}).describe('Deletion result'),
	}),
	z.object({
		type: z.literal('send_apns_push').describe('Response type for APNs push delivery'),
		data: z
			.object({
				success: z.boolean().describe('Whether APNs accepted the notification'),
				should_delete: z.boolean().describe('Whether the gateway should delete this subscription'),
				reason: z.string().optional().describe('APNs or local failure reason'),
				status_code: z.number().optional().describe('APNs HTTP status code'),
			})
			.describe('APNs delivery result'),
	}),
	z.object({
		type: z.literal('get_user_blocked_ids').describe('Response type for blocked user IDs'),
		data: z.record(SnowflakeStringType, z.array(SnowflakeStringType)).describe('Blocked user IDs keyed by user ID'),
	}),
	z.object({
		type: z.literal('voice_get_token').describe('Response type for voice connection token'),
		data: z
			.object({
				token: z.string().describe('Voice server authentication token'),
				endpoint: z.string().describe('Voice server endpoint URL'),
				connectionId: z.string().describe('Unique connection identifier'),
				tokenNonce: z.string().describe('Token nonce for webhook confirmation'),
				regionId: createStringType(1, 64).optional().describe('Voice region selected for the connection'),
				serverId: createStringType(1, 128).optional().describe('Voice server selected for the connection'),
			})
			.describe('Voice connection credentials'),
	}),
	z.object({
		type: z.literal('kick_temporary_member').describe('Response type for temporary member kick'),
		data: z
			.object({
				success: z.boolean().describe('Whether the kick was successful'),
			})
			.describe('Kick result'),
	}),
	z.object({
		type: z.literal('get_badge_counts').describe('Response type for badge counts'),
		data: z
			.object({
				badge_counts: z.record(SnowflakeStringType, z.number().int().min(0)).describe('Badge counts keyed by user ID'),
			})
			.describe('Badge count data'),
	}),
	z.object({
		type: z.literal('voice_force_disconnect_participant').describe('Response type for force disconnect participant'),
		data: z
			.object({
				success: z.boolean().describe('Whether the disconnect was successful'),
			})
			.describe('Disconnect result'),
	}),
	z.object({
		type: z.literal('voice_update_participant').describe('Response type for voice participant update'),
		data: z
			.object({
				success: z.boolean().describe('Whether the update was successful'),
			})
			.describe('Update result'),
	}),
	z.object({
		type: z.literal('voice_force_disconnect_channel').describe('Response type for force disconnect channel'),
		data: z
			.object({
				success: z.boolean().describe('Whether the operation was successful'),
				disconnected_count: z.number().optional().describe('Number of participants disconnected'),
			})
			.describe('Channel disconnect result'),
	}),
	z.object({
		type: z.literal('voice_list_participants').describe('Response type for voice participant listing'),
		data: z
			.object({
				status: z.enum(['ok', 'error']).describe('Whether the participant snapshot is authoritative'),
				participants: z
					.array(
						z.object({
							identity: z.string().describe('LiveKit participant identity'),
							user_id: SnowflakeStringType.describe('Participant user ID'),
							connection_id: createStringType(1, 255).describe('Participant voice connection ID'),
						}),
					)
					.describe('Participants currently present on this voice server'),
				error_code: z.string().optional().describe('Voice server lookup error code'),
				retryable: z.boolean().optional().describe('Whether the lookup can be retried'),
				server_missing: z.boolean().optional().describe('Whether the pinned server no longer exists'),
			})
			.describe('Voice participant listing result'),
	}),
	z.object({
		type: z.literal('voice_update_participant_permissions').describe('Response type for voice permissions update'),
		data: z
			.object({
				success: z.boolean().describe('Whether the permissions update was successful'),
			})
			.describe('Permissions update result'),
	}),
	z.object({
		type: z.literal('call_ended').describe('Response type for call ended notification'),
		data: z
			.object({
				success: z.boolean().describe('Whether the notification was processed successfully'),
			})
			.describe('Call ended result'),
	}),
	z.object({
		type: z.literal('validate_custom_status').describe('Response type for custom status validation'),
		data: RpcResponseValidateCustomStatus.describe('Custom status validation result'),
	}),
	z.object({
		type: z.literal('geoip_lookup').describe('Response type for IP geolocation lookup'),
		data: z
			.object({
				country_code: z.string().describe('Two-letter country code'),
				latitude: createStringType(1, 32).optional().describe('Latitude from IP geolocation'),
				longitude: createStringType(1, 32).optional().describe('Longitude from IP geolocation'),
			})
			.describe('Geolocation result'),
	}),
	z.object({
		type: z.literal('get_dm_channel').describe('Response type for DM channel fetch'),
		data: z
			.object({
				channel: ChannelResponse.nullish().describe('The DM channel or null if not found'),
			})
			.describe('DM channel result'),
	}),
	z.object({
		type: z.literal('get_gateway_rollout_config').describe('Response type for gateway rollout configuration'),
		data: z
			.object({
				config: GatewayRolloutConfigResponse.describe('Gateway rollout configuration'),
			})
			.describe('Gateway rollout config result'),
	}),
	z.object({
		type: z
			.literal('get_push_service_delivery_config')
			.describe('Response type for push service delivery configuration'),
		data: z
			.object({
				config: PushServiceDeliveryConfigResponse.describe('Push service delivery configuration'),
			})
			.describe('Push service delivery config result'),
	}),
	z.object({
		type: z.literal('dave_sender_package').describe('Response type for the DAVE external sender package'),
		data: z
			.object({
				sender_package_b64: DaveBytesType.describe('Base64-encoded DAVE external sender package'),
			})
			.describe('DAVE sender package result'),
	}),
	z.object({
		type: z.literal('dave_validate_key_package').describe('Response type for DAVE key package validation'),
		data: z
			.object({
				valid: z.boolean().describe('Whether the key package is valid for the claimed user'),
				reason: createStringType(0, 512).describe('Validation reason (empty when valid)'),
			})
			.describe('DAVE key package validation result'),
	}),
	z.object({
		type: z.literal('dave_create_proposals').describe('Response type for DAVE proposal creation'),
		data: z
			.object({
				proposals_b64: DaveBytesType.describe('Base64-encoded signed external proposals bundle'),
			})
			.describe('DAVE proposals result'),
	}),
	z.object({
		type: z.literal('dave_parse_commit').describe('Response type for DAVE commit/welcome parsing'),
		data: z
			.object({
				ok: z.boolean().describe('Whether the commit was accepted'),
				reason: createStringType(0, 512).optional().describe('Rejection reason when not ok'),
				new_epoch: z.number().int().min(0).optional().describe('Epoch after the commit'),
				committer_user_id: SnowflakeType.optional().describe('Derived committer user ID'),
				roster: z
					.array(
						z.object({
							user_id: SnowflakeType.describe('Roster member user ID'),
							leaf_index: z.number().int().min(0).describe('Roster member leaf index'),
						}),
					)
					.max(RPC_USER_BATCH_MAX)
					.optional()
					.describe('Post-commit roster'),
				commit_b64: DaveBytesType.optional().describe('Canonical commit bytes'),
				welcome_b64: DaveBytesType.optional().describe('Welcome bytes when the bundle carried one'),
			})
			.describe('DAVE parse commit result'),
	}),
]);

export type RpcResponse = z.infer<typeof RpcResponse>;
