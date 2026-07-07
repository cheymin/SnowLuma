export interface MessageElement {
  type: string;       // 'text'|'at'|'face'|'mface'|'image'|'video'|'record'|'file'|'json'|'xml'|'reply'|'poke'|'forward'
  text?: string;
  faceId?: number;
  targetUin?: number;
  uid?: string;
  imageUrl?: string;
  fileId?: string;
  thumbFileId?: string;
  fileName?: string;
  fileSize?: number;
  replySeq?: number;
  replyMessageId?: number;  // For reply: original message ID (for logging)
  replySenderUin?: number;  // For reply: original sender's UIN
  replyTime?: number;       // For reply: original message timestamp
  replyRandom?: number;     // For reply: original message random/msgId
  replyElements?: MessageElement[];  // Decoded elements of the quoted message (SrcMsg.elems) — lets a backfill reconstruct it for get_msg without a server round-trip
  url?: string;
  thumbUrl?: string;
  subType?: number;
  duration?: number;
  width?: number;
  height?: number;
  summary?: string;
  // Market face (商城表情). Decoded from the wire `marketFace` element; the
  // OneBot layer surfaces it as an `image` segment carrying these as markers,
  // and the send path rebuilds the wire `marketFace` from them.
  //   emojiId        = hex(MarketFace.faceId)  → also builds the gxh gif URL
  //   emojiPackageId = MarketFace.tabId
  //   emojiKey       = MarketFace.key
  emojiId?: string;
  emojiPackageId?: number;
  emojiKey?: string;
  flash?: boolean;
  resId?: string;
  fileHash?: string;
  // 闪传文件 (flash transfer) — decoded from an older-client richui markdown
  // commonElem (svc=45, busId=FlashTransfer). #199/#200. title reuses fileName.
  filesetId?: string;
  sceneType?: number;
  // Preview-bubble metadata for the `forward` element. Drives the
  // `com.tencent.multimsg` LightApp JSON the recipient renders before
  // they tap to expand. When unset, the element builder falls back to
  // generic defaults so old call sites keep working.
  forwardSource?: string;
  forwardSummary?: string;
  forwardPrompt?: string;
  forwardNews?: Array<{ text: string }>;
  forwardTSum?: number;
  /** `uniseq` baked into the preview's LightApp JSON. For a nested
   *  forward, the *outer* upload uses this same uuid as the
   *  `actionCommand` for the piggyback entry carrying the inner
   *  layer's msgBody — so receivers (Mobile QQ / QQ-NT clients) can
   *  resolve the inner layer from the outer's single fetch instead of
   *  hitting the server again. Defaults to a fresh UUID on send when
   *  omitted (i.e. for non-nested forwards). */
  forwardUuid?: string;
  // Server-side fingerprints carried from receive side so a forward can do a
  // pure md5/sha1 fast-upload without re-downloading the original bytes.
  // Set together with `noByteFallback: true` to make the upload modules throw
  // instead of falling back to fetch(url).
  md5Hex?: string;
  sha1Hex?: string;
  picFormat?: number;
  videoFormat?: number;
  voiceFormat?: number;
  noByteFallback?: boolean;
  mediaNode?: {
    fileUuid?: string;
    storeId?: number;
    uploadTime?: number;
    ttl?: number;
    subType?: number;
    info?: {
      fileSize?: number;
      fileHash?: string;
      fileSha1?: string;
      fileName?: string;
      width?: number;
      height?: number;
      time?: number;
      original?: number;
      type?: {
        type?: number;
        picFormat?: number;
        videoFormat?: number;
        voiceFormat?: number;
      };
    };
  };
}

export interface ForwardNodePayload {
  userUin: number;
  nickname: string;
  elements: MessageElement[];
  // Optional context preserved when known (download path or upload-via-id),
  // so `get_forward_msg` can emit OneBot11-compatible OB11Message objects.
  time?: number;
  msgId?: number;
  msgSeq?: number;
  groupId?: number;
  senderCard?: string;
  messageType?: 'group' | 'private';
  // When set, this node's `content` is a nested forward chain. The
  // upload pipeline (see `actions/forward.ts::uploadForwardNodes`)
  // recursively uploads the inner chain and replaces this node's
  // `elements` with an ARK preview element pointing at the inner
  // res_id. We also piggyback the inner chain's msgBody onto the
  // outer long-msg upload as an extra `actionCommand` slot so the
  // NapCat-compatible receiver can walk the whole tree from one
  // server fetch without resolving each layer's res_id separately
  // (modelled after `dev/NapCatQQ/.../SendMsg.uploadForwardedNodesPacket`).
  // Caller never sets this on top-level OneBot input — `parseForward
  // Nodes` synthesises it when it detects a nested-node array.
  innerForward?: ForwardNodePayload[];
}

export interface QQEvent {
  time: number;
  selfUin: number;
}

export interface FriendMessage extends QQEvent {
  kind: 'friend_message';
  senderUin: number;
  senderNick: string;
  msgSeq: number;
  msgId: number;
  elements: MessageElement[];
}

export interface GroupMessage extends QQEvent {
  kind: 'group_message';
  groupId: number;
  senderUin: number;
  senderNick: string;
  senderCard: string;
  senderRole: string;
  msgSeq: number;
  msgId: number;
  elements: MessageElement[];
}

export interface TempMessage extends QQEvent {
  kind: 'temp_message';
  senderUin: number;
  groupId: number;
  senderNick: string;
  msgSeq: number;
  elements: MessageElement[];
}

export interface GroupMemberJoin extends QQEvent {
  kind: 'group_member_join';
  groupId: number;
  userUin: number;
  operatorUin: number;
  userUid?: string;
  operatorUid?: string;
}

export interface GroupMemberLeave extends QQEvent {
  kind: 'group_member_leave';
  groupId: number;
  userUin: number;
  operatorUin: number;
  userUid?: string;
  operatorUid?: string;
  /**
   * Protocol-level reason the member left, derived from
   * GroupChange.decreaseType. `kick` is split into kick / kick_me
   * downstream (OneBot converter) by comparing against selfId.
   */
  leaveType: 'leave' | 'kick' | 'disband';
}

export interface GroupMuteEvent extends QQEvent {
  kind: 'group_mute';
  groupId: number;
  userUin: number;
  operatorUin: number;
  duration: number;
}

export interface GroupAdminEvent extends QQEvent {
  kind: 'group_admin';
  groupId: number;
  userUin: number;
  set: boolean;
}

export interface FriendRecall extends QQEvent {
  kind: 'friend_recall';
  userUin: number;
  msgSeq: number;
}

export interface GroupRecallEvent extends QQEvent {
  kind: 'group_recall';
  groupId: number;
  operatorUin: number;
  authorUin: number;
  msgSeq: number;
}

export interface FriendRequestEvent extends QQEvent {
  kind: 'friend_request';
  fromUin: number;
  fromUid?: string;
  message: string;
  flag: string;
}

export interface GroupInviteEvent extends QQEvent {
  kind: 'group_invite';
  groupId: number;
  fromUin: number;
  fromUid?: string;
  subType: string;
  message: string;
  flag: string;
}

export interface FriendPokeEvent extends QQEvent {
  kind: 'friend_poke';
  userUin: number;
  targetUin: number;
  action: string;
  suffix: string;
  actionImgUrl: string;
}

export interface GroupPokeEvent extends QQEvent {
  kind: 'group_poke';
  groupId: number;
  userUin: number;
  targetUin: number;
  action: string;
  suffix: string;
  actionImgUrl: string;
}

export interface GroupEssenceEvent extends QQEvent {
  kind: 'group_essence';
  groupId: number;
  senderUin: number;
  operatorUin: number;
  msgSeq: number;
  random: number;
  set: boolean;
}

export interface GroupFileUploadEvent extends QQEvent {
  kind: 'group_file_upload';
  groupId: number;
  userUin: number;
  fileId: string;
  fileName: string;
  fileSize: number;
  busId: number;
}

export interface FriendAddEvent extends QQEvent {
  kind: 'friend_add';
  userUin: number;
}

export interface GroupMsgEmojiLikeEvent extends QQEvent {
  kind: 'group_msg_emoji_like';
  groupId: number;
  operatorUin: number;
  operatorUid: string;
  /** Sequence of the message that was reacted to (server-assigned msg_seq). */
  msgSeq: number;
  /** Emoji ID. QQ system faces are short numeric strings; market faces
   *  are alphanumeric. We keep the wire string verbatim. */
  emojiId: string;
  /** Multiplicity of the reaction event. Usually 1. */
  count: number;
  /** True when the reaction is being added; false when removed. */
  isAdd: boolean;
}

/**
 * Async voice-to-text result, pushed by the server (Event 0x210 subType 61)
 * after a `pttTrans.Trans{C2C,Group}PttReq`. `msgId` echoes the request's
 * msgId — the correlation key a pending `fetch_ptt_text` waits on. Internal
 * (not surfaced to OneBot clients).
 */
export interface PttTransResultEvent extends QQEvent {
  kind: 'ptt_trans_result';
  msgId: number;
  text: string;
}

/**
 * The bot account was forced offline (kicked / logged in elsewhere / risk-control)
 * — SSO push `StatusService.KickNT`. Mirrors NapCat's OB11BotOfflineEvent →
 * `notice_type:'bot_offline'`. `tag` = short title, `message` = description.
 */
export interface BotOfflineEvent extends QQEvent {
  kind: 'bot_offline';
  tag: string;
  message: string;
}

/**
 * A group member's card (群名片) changed — detected from message traffic when
 * the sender's live card differs from the cached one (same mechanism as NapCat's
 * `parseCardChangedEvent`). Maps to OB11 `notice_type:'group_card'`.
 */
export interface GroupCardChangeEvent extends QQEvent {
  kind: 'group_card_change';
  groupId: number;
  userUin: number;
  cardNew: string;
  cardOld: string;
}

/**
 * A group member was granted a special title (群头衔) — Event 0x2DC subType 16,
 * field13 == 6. Maps to OB11 `notice/notify` `sub_type:'title'`.
 */
export interface GroupTitleChangeEvent extends QQEvent {
  kind: 'group_title_change';
  groupId: number;
  userUin: number; // the member who received the title
  title: string;
}

/**
 * Group name changed (Event 0x2DC subType 16, field13 == 12). Mirrors NapCat's
 * OB11GroupNameEvent → `notice/notify` `sub_type:'group_name'`.
 */
export interface GroupNameChangeEvent extends QQEvent {
  kind: 'group_name_change';
  groupId: number;
  operatorUin: number; // who renamed the group
  name: string;        // the new group name
}

/**
 * Someone liked the bot's profile card ("名片赞") — Event 0x210 subType 39,
 * inner ProfileLikeTip msgType 0 / subType 203. Mirrors NapCat's
 * OB11ProfileLikeEvent → `notice/notify` `sub_type:'profile_like'`.
 */
export interface FriendProfileLikeEvent extends QQEvent {
  kind: 'friend_profile_like';
  operatorUin: number;   // who liked
  operatorNick: string;
  times: number;         // like count from this event
}

/**
 * C2C "对方正在输入…" input-status push (Event 0x210 subType 0x115 / 277).
 * `eventType` 1 = typing, 3 = recording a voice message. Mirrors NapCat's
 * `onInputStatusPush` → OB11 `notice/notify` `sub_type:'input_status'`.
 */
export interface FriendInputStatusEvent extends QQEvent {
  kind: 'friend_input_status';
  userUin: number;   // the peer whose input status changed (the typer)
  userUid: string;
  eventType: number; // 1 = 正在输入, 3 = 正在讲话(录音)
  statusText: string;
}

export type QQEventVariant =
  | FriendMessage
  | GroupMessage
  | TempMessage
  | GroupMemberJoin
  | GroupMemberLeave
  | GroupMuteEvent
  | GroupAdminEvent
  | FriendRecall
  | GroupRecallEvent
  | FriendRequestEvent
  | GroupInviteEvent
  | FriendPokeEvent
  | GroupPokeEvent
  | GroupEssenceEvent
  | GroupFileUploadEvent
  | FriendAddEvent
  | GroupMsgEmojiLikeEvent
  | PttTransResultEvent
  | FriendInputStatusEvent
  | GroupNameChangeEvent
  | GroupCardChangeEvent
  | GroupTitleChangeEvent
  | FriendProfileLikeEvent
  | BotOfflineEvent;
