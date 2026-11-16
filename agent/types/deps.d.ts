declare module '@dotrino/vault/device-info' {
  export interface DeviceInfo { id: string, vault: string | null, scope: string[], record: number | null, legacyExpires: number | null, proxy: string | null, publickey: string, [k: string]: unknown }
  export function deviceInfo (link: { device?: { publickey?: string }, cert?: object, iss?: string, proxy?: string }, extra?: Record<string, unknown>): Promise<DeviceInfo>
  export function formatDeviceInfo (info: DeviceInfo): string
}
