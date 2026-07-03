-- Per-agent runner provider (gradual Docker -> Fly rollout). 'docker' keeps today's behavior;
-- 'fly' routes provisioner calls to FlyProvisioner. runner_meta holds provider handles
-- (Fly: {machineId, volumeId}); null for docker.
alter table participants add column if not exists runner_provider text not null default 'docker';
alter table participants add column if not exists runner_meta jsonb;
