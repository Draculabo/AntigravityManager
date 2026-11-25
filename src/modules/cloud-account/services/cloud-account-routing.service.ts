import { CloudAccountRepo } from '../persistence/cloudHandler';
import type { SetCloudAccountRoutingInput } from './cloud-account-routing.schema';

export async function setCloudAccountRouting(input: SetCloudAccountRoutingInput): Promise<void> {
  const { updateNestServerAccountRouting } = await import('@/server/main');
  const account = CloudAccountRepo.setAccountRouting(input);
  updateNestServerAccountRouting(account);
}
