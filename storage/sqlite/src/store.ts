import type { ContentAddressedStore } from "@ave/cas";
import { TransactionCoordinator } from "./coordinator.js";
import { DeviceGrantRepository } from "./repositories/device-grant-repository.js";
import { ProjectAssetRevisionRepository } from "./repositories/project-asset-repository.js";
import { PlanApprovalRepository } from "./repositories/plan-approval-repository.js";
import { JobOutboxRepository } from "./repositories/job-outbox-repository.js";
import { ObjectEditRepository } from "./repositories/object-edit-repository.js";

export class AveStore {
  readonly coordinator: TransactionCoordinator;
  readonly devices: DeviceGrantRepository;
  readonly projects: ProjectAssetRevisionRepository;
  readonly plans: PlanApprovalRepository;
  readonly jobs: JobOutboxRepository;
  readonly objectEdits: ObjectEditRepository;

  static async create(rootDir?: string): Promise<AveStore> {
    const coordinator = await TransactionCoordinator.open(rootDir);
    return new AveStore(coordinator);
  }

  constructor(coordinator: TransactionCoordinator) {
    this.coordinator = coordinator;
    this.devices = new DeviceGrantRepository(coordinator);
    this.projects = new ProjectAssetRevisionRepository(coordinator, this.devices);
    this.plans = new PlanApprovalRepository(coordinator, this.devices, this.projects);
    this.jobs = new JobOutboxRepository(coordinator, this.devices, this.projects, this.plans);
    this.objectEdits = new ObjectEditRepository(
      coordinator,
      this.devices,
      this.projects,
      this.plans,
      this.jobs,
    );
    this.plans.bindObjectEdits(this.objectEdits);
    this.jobs.bindObjectEdits(this.objectEdits);
    this.jobs.recoverJobs();
  }

  bindCas(cas: ContentAddressedStore): void {
    this.coordinator.bindCas(cas);
  }

  close(): void {
    this.coordinator.close();
  }
}
