interface TelegramSecureStorage {
  setItem(key: string, value: string, callback: (error: string | null, stored?: boolean) => void): void
  getItem(
    key: string,
    callback: (error: string | null, value?: string | null, canRestore?: boolean) => void,
  ): void
}

interface TelegramWebApp {
  initData: string
  platform: string
  SecureStorage?: TelegramSecureStorage
  ready(): void
  expand(): void
  setHeaderColor?(color: string): void
  setBackgroundColor?(color: string): void
  close(): void
}

interface Window {
  Telegram?: { WebApp: TelegramWebApp }
}

