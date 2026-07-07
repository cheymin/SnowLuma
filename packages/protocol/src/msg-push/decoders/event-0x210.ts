import { protobuf_decode } from '@snowluma/proton';
import { createLogger } from '@snowluma/common/logger';
import type {
  FriendAddEvent,
  FriendPokeEvent,
  FriendRequestEvent,
  QQEventVariant,
} from '../../events';
import type {
  FriendRecall,
  FriendRequest,
  GeneralGrayTipInfo,
  InputStatusNotify,
  NewFriend,
  ProfileLikeTip,
} from '@snowluma/proto-defs/notify';
import type { PttTransPush } from '@snowluma/proto-defs/ptt-trans';
import type { MsgPushContext } from '../context';
import { Event0x210SubType } from '../enums';
import {
  buildTemplateMap, findTemplateValue,
  parseU64OrZero,
  resolveUidToUin,
} from '../helpers';
import type { MsgPushDecoder } from '../registry';

type FriendRecallEvent = Extract<QQEventVariant, { kind: 'friend_recall' }>;
type FriendInputStatusEvent = Extract<QQEventVariant, { kind: 'friend_input_status' }>;
type FriendProfileLikeEvent = Extract<QQEventVariant, { kind: 'friend_profile_like' }>;

const unknownLog = createLogger('MsgPush.Unknown');

export const decodeEvent0x210: MsgPushDecoder = (ctx) => {
  switch (ctx.head.subType as Event0x210SubType) {
    case Event0x210SubType.FriendRequestNotice: return decodeFriendRequest(ctx);
    case Event0x210SubType.PttTransResult: return decodePttTransResult(ctx);
    // 138 (other-recalled) and 139 (self-recalled) share the same
    // FriendRecall wire shape; the helper picks the right uid side
    // based on the subType.
    case Event0x210SubType.FriendRecallNotice:
    case Event0x210SubType.FriendRecallSelfNotice:
      return decodeFriendRecall(ctx);
    case Event0x210SubType.FriendPokeNotice: return decodeFriendPoke(ctx);
    case Event0x210SubType.InputStatusNotice: return decodeInputStatus(ctx);
    case Event0x210SubType.ProfileLikeNotice: return decodeProfileLike(ctx);
    // 179 + 226 both carry the NewFriend payload — see enum comment.
    case Event0x210SubType.NewFriendNotice:
    case Event0x210SubType.NewFriendNoticeAlt:
      return decodeNewFriend(ctx);
    case Event0x210SubType.GroupAppStatePush:
      // QQ-client-internal troop shortcut bar / discussion app state
      // push — no OneBot-level event. See enum comment for the
      // decompiled-source breakdown of the sub_cmd dispatch.
      return [];
    case Event0x210SubType.UnmappedClientState380:
      // QQ-NT-era subType with no reference handler: the legacy QQ
      // Android decompile (tsuzcx/qq_apk) only enumerates SubType0x26
      // through SubType0x146 under msgType0x210/, so 380 / 0x17C is
      // an NT-era addition. None of the NT clients (Lagrange.Core,
      // LagrangeGo, lagrange-python, mania) handle it either. See the
      // enum comment for the full investigation; acknowledge silently
      // until someone maps the schema.
      return [];
  }
  unknownLog.debug('Event0x210 unknown subType=%d', ctx.head.subType);
  return [];
};

// Voice-to-text async result push. Wire shape (live-verified):
//   { f1: uint, f2: { f1 = msgId (echoes the request), f8 = text, ... } }
// `msgId` is the correlation key a pending fetch_ptt_text waits on; we surface
// it + the recognised text as an internal `ptt_trans_result` event.
function decodePttTransResult(ctx: MsgPushContext): QQEventVariant[] {
  const push = protobuf_decode<PttTransPush>(ctx.content);
  const item = push?.item;
  if (!item) return [];
  const msgId = Number(item.msgId ?? 0n);
  const text = item.text ?? '';
  if (!msgId || !text) return [];
  return [{ kind: 'ptt_trans_result', time: ctx.head.timestamp, selfUin: ctx.selfUin, msgId, text }];
}

function decodeFriendRequest(ctx: MsgPushContext): QQEventVariant[] {
  const request = protobuf_decode<FriendRequest>(ctx.content);
  if (!request?.info) return [];
  const sourceUid = request.info.newSource || request.info.sourceUid || '';
  const ev: FriendRequestEvent = {
    kind: 'friend_request',
    time: ctx.head.timestamp,
    selfUin: ctx.selfUin,
    fromUin: resolveUidToUin(ctx.identity, 0, sourceUid, ctx.fromUin),
    fromUid: sourceUid,
    message: request.info.message ?? '',
    flag: sourceUid,
  };
  return [ev];
}

function decodeFriendRecall(ctx: MsgPushContext): QQEventVariant[] {
  const recall = protobuf_decode<FriendRecall>(ctx.content);
  if (!recall?.info) return [];
  // 138 = friend recalled their own message sent to bot (peer = fromUid).
  // 139 = bot recalled own message sent to friend (peer = toUid). Same
  // ambiguity acidify handles in `parseFriendRecall:380`. Without this
  // split, self-recall events surface `userUin` as the bot itself which
  // confuses downstream OneBot consumers that key off `user_id`.
  const isSelfRecall = ctx.head.subType === Event0x210SubType.FriendRecallSelfNotice;
  const peerUid = (isSelfRecall ? recall.info.toUid : recall.info.fromUid) ?? '';
  const ev: FriendRecallEvent = {
    kind: 'friend_recall',
    time: recall.info.time ?? ctx.head.timestamp,
    selfUin: ctx.selfUin,
    userUin: resolveUidToUin(ctx.identity, 0, peerUid, ctx.fromUin),
    msgSeq: recall.info.clientSequence ?? 0,
  };
  return [ev];
}

function decodeNewFriend(ctx: MsgPushContext): QQEventVariant[] {
  const nf = protobuf_decode<NewFriend>(ctx.content);
  if (!nf?.info) return [];
  const newFriendUid = nf.info.uid ?? '';
  const newFriendUin = resolveUidToUin(ctx.identity, 0, newFriendUid, ctx.fromUin);
  if (newFriendUin <= 0) return []; // can't surface a `user_id`-less friend_add to OneBot
  const ev: FriendAddEvent = {
    kind: 'friend_add',
    // proto field is `fixed32 Time` — already uint32 seconds epoch.
    // Fall back to head.timestamp if the field is missing (some
    // captures have it as 0).
    time: nf.info.time && nf.info.time > 0 ? nf.info.time : ctx.head.timestamp,
    selfUin: ctx.selfUin,
    userUin: newFriendUin,
  };
  return [ev];
}

// C2C "对方正在输入…" input-status push. Body (`InputStatusNotify`) rides in
// `body.msgContent` (= ctx.content). Layout + event-type semantics RE'd from
// `aio_input_state_worker.cc::ProcessInputStateNotifySysMsg`: the notify item's
// field 4 is the event type (1 = typing, 3 = recording voice). The client
// synthesises the status text from that type, so we do the same for OneBot
// parity (NapCat's `onInputStatusPush` → `notice/notify` `input_status`).
function decodeInputStatus(ctx: MsgPushContext): QQEventVariant[] {
  const notify = protobuf_decode<InputStatusNotify>(ctx.content);
  const fromUid = notify?.fromUid ?? '';
  if (!fromUid) return [];
  const eventType = notify.notifyItem?.eventType ?? 1;
  const ev: FriendInputStatusEvent = {
    kind: 'friend_input_status',
    time: ctx.head.timestamp,
    selfUin: ctx.selfUin,
    userUin: resolveUidToUin(ctx.identity, 0, fromUid, ctx.fromUin),
    userUid: fromUid,
    eventType,
    statusText: inputStatusText(eventType),
  };
  return [ev];
}

// The client's own strings (wrapper.linux.node @0xB8FFE0 / @0xB90000).
function inputStatusText(eventType: number): string {
  return eventType === 3 ? '对方正在讲话...' : '对方正在输入...';
}

// subType 39 is multiplexed; body.msgContent decodes as ProfileLikeTip and is a
// profile-like ("名片赞") only when inner msgType==0 && subType==203. Other 39
// variants (multi-device sync etc.) decode to a non-matching tip → dropped.
// `times` is the like count parsed out of `detail.txt` ("赞了我的资料卡N次").
// Field layout confirmed byte-exact against real on-wire captures.
function decodeProfileLike(ctx: MsgPushContext): QQEventVariant[] {
  const tip = protobuf_decode<ProfileLikeTip>(ctx.content);
  // msgType 0 is the proto default → omitted on the wire → decodes as undefined,
  // so treat missing as 0 (matches NapCat's `msgType !== 0` check).
  if (!tip || (tip.msgType ?? 0) !== 0 || (tip.subType ?? 0) !== 203) return [];
  const msg = tip.content?.msg;
  const detail = msg?.detail;
  const operatorUin = Number(detail?.uin ?? 0n);
  if (!operatorUin) return [];
  const times = Number.parseInt((detail?.txt ?? '').match(/\d+/)?.[0] ?? '0', 10) || 0;
  const ev: FriendProfileLikeEvent = {
    kind: 'friend_profile_like',
    time: msg?.time || ctx.head.timestamp,
    selfUin: ctx.selfUin,
    operatorUin,
    operatorNick: detail?.nickname ?? '',
    times,
  };
  return [ev];
}

function decodeFriendPoke(ctx: MsgPushContext): QQEventVariant[] {
  const grayTip = protobuf_decode<GeneralGrayTipInfo>(ctx.content);
  if (!grayTip || (grayTip.busiType ?? 0n) !== 12n) return [];
  const templates = buildTemplateMap(grayTip.msgTemplParam ?? []);
  const actor = findTemplateValue(templates, 'uin_str1');
  const target = findTemplateValue(templates, 'uin_str2');
  const ev: FriendPokeEvent = {
    kind: 'friend_poke',
    time: ctx.head.timestamp,
    selfUin: ctx.selfUin,
    userUin: resolveUidToUin(ctx.identity, 0, actor, parseU64OrZero(actor)),
    targetUin: resolveUidToUin(ctx.identity, 0, target, parseU64OrZero(target)),
    action: findTemplateValue(templates, 'action_str', 'alt_str1'),
    suffix: findTemplateValue(templates, 'suffix_str'),
    actionImgUrl: findTemplateValue(templates, 'action_img_url'),
  };
  return [ev];
}
