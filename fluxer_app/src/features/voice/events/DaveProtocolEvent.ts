// SPDX-License-Identifier: AGPL-3.0-or-later

import type {GatewayHandlerContext} from '@app/features/gateway/events/EventRouter';
import MediaEngine from '@app/features/voice/engine/MediaEngineFacade';
import {Logger} from '@app/features/platform/utils/AppLogger';

const logger = new Logger('DaveProtocolEvent');

export interface DaveProtocolEventPayload {
	channel_id: string;
	guild_id?: string | null;
	type:
		| 'select_protocol_ack'
		| 'prepare_transition'
		| 'execute_transition'
		| 'prepare_epoch'
		| 'external_sender_package'
		| 'proposals'
		| 'announce_commit_transition'
		| 'welcome';
	version?: number;
	transition_id?: number;
	epoch?: string;
	data?: string;
	target_user_id?: string;
}

/**
 * Gateway `DAVE_PROTOCOL_EVENT` entry point. Forwards the downlink DAVE event to
 * the active voice connection's DaveClient via the media engine facade, which in
 * turn pushes any resulting key ratchets into the room's E2EE worker.
 */
export function handleDaveProtocolEvent(
	data: DaveProtocolEventPayload,
	_context: GatewayHandlerContext,
): void {
	if (!data || !data.channel_id || !data.type) {
		logger.warn('Ignoring malformed DAVE_PROTOCOL_EVENT', {data});
		return;
	}
	MediaEngine.handleDaveProtocolEvent(data);
}
