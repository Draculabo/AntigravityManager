import { ManagementClient } from '@/core/management/client';
import { getManagementEndpoint } from '@/core/management/endpoint';
import { getProfileOwnershipEndpoint, probeProfileOwner } from '@/core/ownership/profile-lease';
import { runCli } from './app';
import { launchDetachedCore, resolveCoreEntry, ServiceLauncher } from './service-launcher';
import { CoreRpcClient } from '@/core/rpc/client';

const management = new ManagementClient(getManagementEndpoint());
const application = new CoreRpcClient(getManagementEndpoint());
const launcher = new ServiceLauncher({
  management,
  probeProfileOwner: () => probeProfileOwner(getProfileOwnershipEndpoint()),
  launchCore: () => launchDetachedCore(resolveCoreEntry(process.argv[1])),
});

void runCli(
  process.argv.slice(2),
  launcher,
  {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  },
  management,
  application,
  application,
).then((exitCode) => {
  process.exitCode = exitCode;
});
