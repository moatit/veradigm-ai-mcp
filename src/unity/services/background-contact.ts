import type { UnityTargetSystem } from '../config/unity-endpoints';

/**
 * Per system: when Drawbridge last contacted Veradigm on its own (health probe, keep-warm renewal,
 * GetServerInfo refresh), success or not. The health probe uses it for the 2-minute polling floor, so
 * background traffic of any kind keeps the probe away. One shared clock per process (backgroundContact);
 * tests pass their own.
 */
export class BackgroundContact {
  private last = new Map<UnityTargetSystem, number>();

  note(target: UnityTargetSystem, at: number = Date.now()): void {
    this.last.set(target, at);
  }

  lastAt(target: UnityTargetSystem): number {
    return this.last.get(target) || 0;
  }
}

export const backgroundContact = new BackgroundContact();
