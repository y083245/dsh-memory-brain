// QQ transport boundary. Existing QQ-specific tools can use the OneBot client
// while the bridge routes incoming events and plain text through this adapter.
function escapeCqText(text) {
  return String(text ?? '').replace(/\[CQ:/gi, '[CQ：');
}

export async function createQQAdapter(config, {
  loadSdk = () => import('@snowluma/sdk'),
  fetch = globalThis.fetch,
} = {}) {
  const { SnowLumaWebSocketClient, text } = await loadSdk();
  const bot = new SnowLumaWebSocketClient({
    url: config.wsUrl,
    // The WS and HTTP tokens may differ. Keep the HTTP fallback for older configs.
    accessToken: config.wsAccessToken || config.accessToken || undefined,
    reconnect: true,
  });

  function bindIngress({ onMessage, onPoke, onRecall, log = () => {} }) {
    // OneBot can serialize the same identity as either a string or a number.
    const isSelf = (id, event) => String(id ?? '') === String(event?.self_id ?? '');
    bot.onPrivateMessage(async (event) => {
      if (isSelf(event?.user_id, event)) return;
      try { await onMessage('private', event.user_id, event); }
      catch (error) { log('处理私聊消息出错:', error?.message ?? error); }
    });
    bot.onGroupMessage(async (event) => {
      if (isSelf(event?.sender?.user_id, event) || isSelf(event?.user_id, event)) return;
      try { await onMessage('group', event.group_id, event); }
      catch (error) { log('处理群消息出错:', error?.message ?? error); }
    });
    bot.onNotice('notify', async (event) => {
      try { await onPoke(event); }
      catch (error) { log('处理拍一拍事件出错:', error?.message ?? error); }
    });
    for (const noticeType of ['group_recall', 'friend_recall']) {
      try {
        bot.onNotice(noticeType, async (event) => {
          try { await onRecall({ ...event, notice_type: noticeType }); }
          catch (error) { log('处理撤回事件出错:', error?.message ?? error); }
        });
      } catch (error) {
        log(`（撤回事件订阅不可用 ${noticeType}：${error?.message ?? error}）`);
      }
    }
  }

  function sendText(kind, id, message) {
    const segment = text(escapeCqText(message));
    return kind === 'private'
      ? bot.sendPrivateMessage(Number(id), segment)
      : bot.sendGroupMessage(Number(id), segment);
  }

  async function sendStructuredText(kind, id, message, replyToMessageId, atUserId = null) {
    const segments = [];
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      // 只允许正整数 QQ 号，禁止 @all，避免被滥用成 @全体成员
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      segments.push({ type: 'at', data: { qq: at } });
    }
    segments.push({ type: 'text', data: { text: escapeCqText(message) } });
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments };
    const httpUrl = String(config.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const res = await fetch(`${httpUrl}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.accessToken ? { authorization: `Bearer ${config.accessToken}` } : {})
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(15000)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
      const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址）' : '';
      throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
    }
    return body.data;
  }

  return { bot, bindIngress, sendText, sendStructuredText };
}
