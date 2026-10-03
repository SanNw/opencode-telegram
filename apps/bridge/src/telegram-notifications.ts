import type { NormalizedOpenCodeEvent } from "./opencode.js"

type TelegramNotificationConfig = {
  botToken: string
  ownerId: string
  miniAppUrl?: string
}

type Fetcher = typeof fetch

async function sendNotification(config: TelegramNotificationConfig, text: string, fetcher: Fetcher) {
  const response = await fetcher(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: config.ownerId,
      text,
      disable_notification: false,
      ...(config.miniAppUrl ? {
        reply_markup: { inline_keyboard: [[{ text: "Open Mini App", web_app: { url: config.miniAppUrl } }]] },
      } : {}),
    }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`Telegram notification failed (${response.status})`)
}

export async function runTelegramNotifications(
  config: TelegramNotificationConfig,
  events: AsyncIterable<NormalizedOpenCodeEvent>,
  fetcher: Fetcher = fetch,
  remoteAccessEnabled: () => boolean = () => true,
) {
  const busy = new Set<string>()
  const permissionRequests = new Set<string>()
  const titles = new Map<string, string>()
  const label = (sessionId: string) => titles.get(sessionId) ?? sessionId
  const notify = async (text: string) => {
    if (!remoteAccessEnabled()) return
    try {
      await sendNotification(config, text, fetcher)
    } catch (error) {
      console.warn(JSON.stringify({
        event: "telegram.notification_failed",
        error: error instanceof Error ? error.message : "unknown",
      }))
    }
  }

  for await (const event of events) {
    if (!remoteAccessEnabled()) {
      busy.clear(); permissionRequests.clear(); titles.clear()
      continue
    }
    if (event.type === "session.updated") titles.set(event.session.id, event.session.title)
    if (event.type === "session.status" && event.status === "busy") busy.add(event.sessionId)
    if ((event.type === "session.idle" || (event.type === "session.status" && event.status === "idle")) && busy.delete(event.sessionId)) {
      await notify(`OpenCode finished: ${label(event.sessionId)}`)
    }
    if (event.type === "session.error" && event.sessionId) {
      busy.delete(event.sessionId)
      await notify(`OpenCode reported an error: ${label(event.sessionId)}`)
    }
    if (event.type === "permission.requested" && !permissionRequests.has(event.requestId)) {
      permissionRequests.add(event.requestId)
      await notify(`OpenCode needs approval for ${event.action}: ${label(event.sessionId)}`)
    }
    if (event.type === "permission.resolved") permissionRequests.delete(event.requestId)
  }
}
