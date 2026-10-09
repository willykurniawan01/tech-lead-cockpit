import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hashPin, SecurityStore } from './security.svelte';

describe('SecurityStore', () => {
  let store: SecurityStore;

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    store = new SecurityStore();
  });

  it('hashes pin consistently with same salt', async () => {
    const salt = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    const hash1 = await hashPin('123456', salt);
    const hash2 = await hashPin('123456', salt);
    expect(hash1).toBe(hash2);
    expect(hash1.length).toBeGreaterThan(10);

    const hashDiff = await hashPin('654321', salt);
    expect(hash1).not.toBe(hashDiff);
  });

  it('sets up PIN and unlocks', async () => {
    expect(store.isConfigured).toBe(false);
    expect(store.isUnlocked).toBe(false);

    const res = await store.setupPin('123456');
    expect(res.success).toBe(true);
    expect(store.isConfigured).toBe(true);
    expect(store.isUnlocked).toBe(true);

    // Verify correct PIN
    const ok = await store.verifyPin('123456');
    expect(ok).toBe(true);

    // Verify wrong PIN
    const wrong = await store.verifyPin('999999');
    expect(wrong).toBe(false);
  });

  it('locks and unlocks correctly', async () => {
    await store.setupPin('123456');
    expect(store.isUnlocked).toBe(true);

    store.lock();
    expect(store.isUnlocked).toBe(false);

    const verified = await store.verifyPin('123456');
    expect(verified).toBe(true);
    expect(store.isUnlocked).toBe(true);
  });

  it('changes PIN with old PIN verification', async () => {
    await store.setupPin('123456');

    // Fail with wrong old PIN
    const fail = await store.changePin('000000', '654321');
    expect(fail.success).toBe(false);
    expect(fail.error).toContain('PIN lama salah');

    // Succeed with right old PIN
    const ok = await store.changePin('123456', '654321');
    expect(ok.success).toBe(true);

    // Old PIN should no longer work
    expect(await store.verifyPin('123456')).toBe(false);
    // New PIN works
    expect(await store.verifyPin('654321')).toBe(true);
  });

  it('rejects PIN shorter than 4 digits', async () => {
    const res = await store.setupPin('12');
    expect(res.success).toBe(false);
    expect(res.error).toContain('minimal 4 digit');
  });

  it('locks out after 5 failed attempts', async () => {
    await store.setupPin('123456');
    store.lock();

    for (let i = 0; i < 4; i++) {
      expect(await store.verifyPin('000000')).toBe(false);
      expect(store.isLockedOut()).toBe(false);
    }

    // 5th attempt triggers lockout
    expect(await store.verifyPin('000000')).toBe(false);
    expect(store.isLockedOut()).toBe(true);
    expect(store.lockoutSecondsRemaining()).toBeGreaterThan(0);
  });

  it('accepts only 4–8 digit PINs, the characters the unlock keypad can enter', async () => {
    expect((await store.setupPin('12ab')).success).toBe(false);
    expect((await store.setupPin('123')).success).toBe(false);
    expect((await store.setupPin('123456789')).success).toBe(false);
    expect(store.isConfigured).toBe(false);
    expect((await store.setupPin('12345678')).success).toBe(true);
  });

  it('remembers the PIN length so the unlock screen knows when to submit', async () => {
    await store.setupPin('2468');
    expect(store.pinLength).toBe(4);
    expect(new SecurityStore().pinLength).toBe(4);
  });

  it('learns the length of PINs saved before it was recorded', async () => {
    await store.setupPin('1234567');
    localStorage.removeItem('tlc.security.pin_length');
    const legacy = new SecurityStore();
    expect(legacy.pinLength).toBe(0);
    expect(await legacy.verifyPin('1234567')).toBe(true);
    expect(legacy.pinLength).toBe(7);
  });

  it('opens right after setup even if Touch ID registration never answers', async () => {
    store.biometricsSupported = true;
    vi.spyOn(store, 'registerBiometrics').mockReturnValue(new Promise(() => {}));
    const res = await store.setupPin('135790', true);
    expect(res.success).toBe(true);
    expect(store.isUnlocked).toBe(true);
  });
});
