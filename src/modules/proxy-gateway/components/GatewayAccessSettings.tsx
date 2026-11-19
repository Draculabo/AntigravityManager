import { useState } from 'react';
import {
  ServiceProxySchema,
  type ServiceConfigSnapshot,
} from '@/modules/config/service-config.schema';
type ProxyConfig = ServiceConfigSnapshot['proxy'];
import { useTranslation } from 'react-i18next';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { CommitOnBlurNumberInput, Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

export function GatewayAccessSettings({
  proxyConfig,
  portEditable,
  updateProxyConfig,
}: {
  proxyConfig: ProxyConfig;
  portEditable: boolean;
  updateProxyConfig(next: ProxyConfig): Promise<void>;
}) {
  const { t } = useTranslation();
  const [invalidPort, setInvalidPort] = useState(false);
  const [invalidTimeout, setInvalidTimeout] = useState(false);
  const [networkDrafts, setNetworkDrafts] = useState({
    allowlist: '',
    blocklist: '',
    trustedProxyCidrs: '',
  });

  const syncNetworkDrafts = (nextProxyConfig: ProxyConfig) => {
    setNetworkDrafts({
      allowlist: nextProxyConfig.network.ip_allowlist.join(', '),
      blocklist: nextProxyConfig.network.ip_blocklist.join(', '),
      trustedProxyCidrs: nextProxyConfig.network.trusted_proxy_cidrs.join(', '),
    });
  };

  const [previousNetwork, setPreviousNetwork] = useState<ProxyConfig['network']>();
  if (previousNetwork !== proxyConfig.network) {
    setPreviousNetwork(proxyConfig.network);
    syncNetworkDrafts(proxyConfig);
  }
  const updateNetworkList = async (
    field: 'ip_allowlist' | 'ip_blocklist' | 'trusted_proxy_cidrs',
    draftField: 'allowlist' | 'blocklist' | 'trustedProxyCidrs',
  ) => {
    if (!proxyConfig) {
      return;
    }
    const values = networkDrafts[draftField]
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    await updateProxyConfig({
      ...proxyConfig,
      network: { ...proxyConfig.network, [field]: values },
    });
  };

  const updateGatewayPort = (value: string) => {
    const port = ServiceProxySchema.shape.port.safeParse(Number(value));
    setInvalidPort(!port.success);
    if (port.success && port.data !== proxyConfig.port) {
      return updateProxyConfig({ ...proxyConfig, port: port.data });
    }
  };

  return (
    <details className="bg-card rounded-lg border p-4">
      <summary className="focus-visible:ring-ring cursor-default rounded-sm text-sm font-semibold focus-visible:ring-2 focus-visible:outline-none">
        {t('proxy.workspace.listener')}
        <span className="text-muted-foreground ms-3 text-xs font-normal">
          {t(proxyConfig.network.lan_access ? 'proxy.workspace.lan' : 'proxy.workspace.local')} ·{' '}
          {proxyConfig.port}
        </span>
      </summary>
      <div className="mt-4 space-y-4">
        {/* Port & Timeout Configuration */}
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="gateway-port">{t('proxy.config.port')}</Label>
            <CommitOnBlurNumberInput
              id="gateway-port"
              value={proxyConfig.port}
              min={1024}
              max={65535}
              onCommit={updateGatewayPort}
              disabled={!portEditable}
              aria-invalid={invalidPort}
              aria-describedby={invalidPort ? 'gateway-port-error' : undefined}
            />
            {invalidPort && (
              <p id="gateway-port-error" role="alert" className="text-destructive text-xs">
                {t('proxy.workspace.port-invalid')}
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="gateway-timeout">{t('proxy.config.timeout')}</Label>
            <CommitOnBlurNumberInput
              id="gateway-timeout"
              value={proxyConfig.generation_timeout}
              min={1}
              max={3600}
              onCommit={(value) => {
                const timeout = ServiceProxySchema.shape.generation_timeout.safeParse(
                  Number(value),
                );
                setInvalidTimeout(!timeout.success);
                if (timeout.success && timeout.data !== proxyConfig.generation_timeout) {
                  return updateProxyConfig({ ...proxyConfig, generation_timeout: timeout.data });
                }
              }}
              aria-invalid={invalidTimeout}
              aria-describedby={invalidTimeout ? 'gateway-timeout-error' : undefined}
            />
            {invalidTimeout && (
              <p id="gateway-timeout-error" role="alert" className="text-destructive text-xs">
                {t('proxy.workspace.timeout-invalid')}
              </p>
            )}
          </div>
        </div>
        {/* Auto Start Toggle */}
        <div className="flex items-center justify-between gap-4 border-t pt-4">
          <div className="space-y-1">
            <Label htmlFor="proxy-auto-start">{t('proxy.config.auto_start')}</Label>
            <p className="text-muted-foreground text-xs">{t('proxy.config.auto_start_desc')}</p>
          </div>
          <Switch
            id="proxy-auto-start"
            checked={proxyConfig.auto_start}
            onCheckedChange={(checked) =>
              updateProxyConfig({ ...proxyConfig, auto_start: checked })
            }
          />
        </div>
        <div className="flex items-center justify-between gap-4 border-t pt-4">
          <div className="space-y-1">
            <Label htmlFor="proxy-lan-access">{t('proxy.config.lan_access')}</Label>
            <p className="text-muted-foreground text-xs">{t('proxy.config.lan_access_desc')}</p>
          </div>
          <Switch
            id="proxy-lan-access"
            checked={proxyConfig.network.lan_access}
            onCheckedChange={(checked) =>
              updateProxyConfig({
                ...proxyConfig,
                network: { ...proxyConfig.network, lan_access: checked },
              })
            }
          />
        </div>
        <details className="group border-t pt-4">
          <summary className="focus-visible:ring-ring cursor-default rounded-sm text-sm font-medium focus-visible:ring-2 focus-visible:outline-none">
            {t('proxy.config.ip_access_title', 'IP access rules')}
          </summary>
          <p className="text-muted-foreground mt-1 text-xs">
            {t(
              'proxy.config.ip_access_desc',
              'Restrict model, WebSocket, and public management requests by client address. Values are comma-separated IPs or CIDR ranges.',
            )}
          </p>
          <div className="mt-4 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="proxy-ip-filter-mode">
                {t('proxy.config.ip_filter_mode', 'IP filter mode')}
              </Label>
              <Select
                value={proxyConfig.network.ip_filter_mode}
                onValueChange={(ip_filter_mode: ProxyConfig['network']['ip_filter_mode']) =>
                  updateProxyConfig({
                    ...proxyConfig,
                    network: { ...proxyConfig.network, ip_filter_mode },
                  })
                }
              >
                <SelectTrigger id="proxy-ip-filter-mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="off">{t('proxy.config.ip_filter_off', 'Off')}</SelectItem>
                  <SelectItem value="allowlist">
                    {t('proxy.config.ip_filter_allowlist', 'Allowlist only')}
                  </SelectItem>
                  <SelectItem value="blocklist">
                    {t('proxy.config.ip_filter_blocklist', 'Blocklist')}
                  </SelectItem>
                  <SelectItem value="allowlist-and-blocklist">
                    {t('proxy.config.ip_filter_both', 'Allowlist and blocklist')}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="proxy-ip-allowlist">
                {t('proxy.config.ip_allowlist', 'Allowed IPs or CIDRs')}
              </Label>
              <Input
                id="proxy-ip-allowlist"
                value={networkDrafts.allowlist}
                placeholder="192.168.1.0/24, 2001:db8::/32"
                onChange={(event) =>
                  setNetworkDrafts((current) => ({ ...current, allowlist: event.target.value }))
                }
                onBlur={() => void updateNetworkList('ip_allowlist', 'allowlist')}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="proxy-ip-blocklist">
                {t('proxy.config.ip_blocklist', 'Blocked IPs or CIDRs')}
              </Label>
              <Input
                id="proxy-ip-blocklist"
                value={networkDrafts.blocklist}
                placeholder="192.168.1.100, 2001:db8:bad::/48"
                onChange={(event) =>
                  setNetworkDrafts((current) => ({ ...current, blocklist: event.target.value }))
                }
                onBlur={() => void updateNetworkList('ip_blocklist', 'blocklist')}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="proxy-trusted-proxy-cidrs">
                {t('proxy.config.trusted_proxy_cidrs', 'Trusted proxy CIDRs')}
              </Label>
              <Input
                id="proxy-trusted-proxy-cidrs"
                value={networkDrafts.trustedProxyCidrs}
                placeholder="10.0.0.0/8, 2001:db8:100::/48"
                onChange={(event) =>
                  setNetworkDrafts((current) => ({
                    ...current,
                    trustedProxyCidrs: event.target.value,
                  }))
                }
                onBlur={() => void updateNetworkList('trusted_proxy_cidrs', 'trustedProxyCidrs')}
              />
            </div>

            <div className="flex items-center justify-between gap-4">
              <div className="space-y-1">
                <Label htmlFor="proxy-allowlist-precedence">
                  {t('proxy.config.allowlist_precedence', 'Allowlist takes precedence')}
                </Label>
                <p className="text-muted-foreground text-xs">
                  {t(
                    'proxy.config.allowlist_precedence_desc',
                    'An allowlisted address can bypass a matching blocklist entry.',
                  )}
                </p>
              </div>
              <Switch
                id="proxy-allowlist-precedence"
                checked={proxyConfig.network.allowlist_takes_precedence}
                onCheckedChange={(allowlist_takes_precedence) =>
                  updateProxyConfig({
                    ...proxyConfig,
                    network: { ...proxyConfig.network, allowlist_takes_precedence },
                  })
                }
              />
            </div>
          </div>
        </details>
      </div>
    </details>
  );
}
