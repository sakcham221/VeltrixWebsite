export const adConfig = {
  enabled: import.meta.env.VITE_ADS_ENABLED === 'true',
  provider: import.meta.env.VITE_AD_PROVIDER || '',
  clientId: import.meta.env.VITE_AD_CLIENT_ID || '',
};

export function isAdEnabled() {
  return adConfig.enabled;
}
