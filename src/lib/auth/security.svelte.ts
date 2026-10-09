/**
 * Security and authentication service for Tech Lead Cockpit.
 * Supports:
 * - 4-8 digit / alphanumeric PIN with PBKDF2 + SHA-256 salted hashing.
 * - Native macOS Touch ID / Biometrics via WebAuthn (PublicKeyCredential).
 * - Auto-lock on inactivity / session restart.
 */

const STORAGE_KEYS = {
  PIN_HASH: 'tlc.security.pin_hash',
  PIN_SALT: 'tlc.security.pin_salt',
  BIOMETRICS_ENABLED: 'tlc.security.biometrics_enabled',
  CREDENTIAL_ID: 'tlc.security.credential_id',
  AUTOLOCK_SECONDS: 'tlc.security.autolock_seconds',
  LAST_ACTIVITY: 'tlc.security.last_activity',
  SESSION_UNLOCKED: 'tlc.session.unlocked',
  /** Lets the unlock screen show the right number of dots and submit on the last digit. */
  PIN_LENGTH: 'tlc.security.pin_length',
};

export const PIN_MIN = 4;
export const PIN_MAX = 8;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

export async function hashPin(pin: string, salt: Uint8Array): Promise<string> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(pin),
    { name: 'PBKDF2' },
    false,
    ['deriveKey'],
  );
  const derivedKey = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as any,
      iterations: 10000,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt'],
  );
  const rawKey = await crypto.subtle.exportKey('raw', derivedKey);
  return bytesToHex(new Uint8Array(rawKey));
}

export class SecurityStore {
  isConfigured = $state(false);
  isUnlocked = $state(false);
  biometricsEnabled = $state(false);
  biometricsSupported = $state(false);
  autoLockSeconds = $state(0); // 0 = every launch/refresh, 300 = 5m, 900 = 15m, -1 = never
  failedAttempts = $state(0);
  lockoutUntil = $state(0);
  /** Length of the saved PIN; 0 for PINs created before it was recorded. */
  pinLength = $state(0);

  private activityTimer: any = null;

  constructor() {
    this.init();
  }

  init() {
    if (typeof window === 'undefined') return;

    const hash = localStorage.getItem(STORAGE_KEYS.PIN_HASH);
    const salt = localStorage.getItem(STORAGE_KEYS.PIN_SALT);
    this.isConfigured = Boolean(hash && salt);

    this.biometricsEnabled = localStorage.getItem(STORAGE_KEYS.BIOMETRICS_ENABLED) === 'true';
    this.pinLength = Number(localStorage.getItem(STORAGE_KEYS.PIN_LENGTH) || 0);

    const savedAutoLock = localStorage.getItem(STORAGE_KEYS.AUTOLOCK_SECONDS);
    this.autoLockSeconds = savedAutoLock !== null ? Number(savedAutoLock) : 0;

    // Check device WebAuthn / Touch ID support
    this.checkBiometricsSupport();

    // Check existing unlock state in this session
    if (!this.isConfigured) {
      // If never configured, not unlocked yet, but will show Setup Screen
      this.isUnlocked = false;
    } else {
      const isSessionUnlocked = sessionStorage.getItem(STORAGE_KEYS.SESSION_UNLOCKED) === 'true';
      const lastActivity = Number(sessionStorage.getItem(STORAGE_KEYS.LAST_ACTIVITY) || 0);
      const now = Date.now();

      if (isSessionUnlocked && this.autoLockSeconds > 0 && lastActivity > 0) {
        const elapsed = (now - lastActivity) / 1000;
        if (elapsed < this.autoLockSeconds) {
          this.isUnlocked = true;
          this.recordActivity();
        } else {
          this.lock();
        }
      } else if (isSessionUnlocked && this.autoLockSeconds === -1) {
        this.isUnlocked = true;
      } else {
        // Default (autoLock 0 or new session): require unlock on open
        this.lock();
      }
    }

    this.setupActivityListeners();
  }

  private async checkBiometricsSupport() {
    if (typeof window === 'undefined' || !window.PublicKeyCredential) {
      this.biometricsSupported = false;
      return;
    }
    try {
      this.biometricsSupported = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    } catch {
      this.biometricsSupported = false;
    }
  }

  private setupActivityListeners() {
    if (typeof window === 'undefined') return;
    const update = () => {
      if (this.isUnlocked) {
        this.recordActivity();
      }
    };
    window.addEventListener('mousemove', update, { passive: true });
    window.addEventListener('keydown', update, { passive: true });
    window.addEventListener('click', update, { passive: true });

    // Periodic check for auto-lock timeout
    clearInterval(this.activityTimer);
    this.activityTimer = setInterval(() => {
      if (this.isUnlocked && this.autoLockSeconds > 0) {
        const lastActivity = Number(sessionStorage.getItem(STORAGE_KEYS.LAST_ACTIVITY) || 0);
        if (lastActivity > 0 && Date.now() - lastActivity > this.autoLockSeconds * 1000) {
          this.lock();
        }
      }
    }, 10000);
  }

  private recordActivity() {
    sessionStorage.setItem(STORAGE_KEYS.LAST_ACTIVITY, String(Date.now()));
  }

  async setupPin(pin: string, enableBiometrics = false): Promise<{ success: boolean; error?: string }> {
    // Digits only: the unlock keypad can't enter anything else.
    if (!pin || pin.length < PIN_MIN) return { success: false, error: `PIN minimal ${PIN_MIN} digit.` };
    if (!new RegExp(`^\\d{${PIN_MIN},${PIN_MAX}}$`).test(pin)) {
      return { success: false, error: `PIN harus berupa ${PIN_MIN}–${PIN_MAX} angka.` };
    }
    try {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const hash = await hashPin(pin, salt);

      localStorage.setItem(STORAGE_KEYS.PIN_SALT, bytesToHex(salt));
      localStorage.setItem(STORAGE_KEYS.PIN_HASH, hash);
      this.rememberPinLength(pin.length);
      this.isConfigured = true;
      // Open first: Touch ID registration can hang in some WebViews and must not keep the user out.
      this.unlock();

      if (enableBiometrics && this.biometricsSupported) {
        void this.registerBiometrics();
      }
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message || 'Gagal menyimpan PIN' };
    }
  }

  async verifyPin(pin: string): Promise<boolean> {
    if (this.isLockedOut()) return false;

    const saltHex = localStorage.getItem(STORAGE_KEYS.PIN_SALT);
    const expectedHash = localStorage.getItem(STORAGE_KEYS.PIN_HASH);
    if (!saltHex || !expectedHash) return false;

    try {
      const salt = hexToBytes(saltHex);
      const computedHash = await hashPin(pin, salt);
      if (computedHash === expectedHash) {
        this.failedAttempts = 0;
        if (this.pinLength !== pin.length) this.rememberPinLength(pin.length);
        this.unlock();
        return true;
      }
    } catch {
      /* ignore */
    }

    this.failedAttempts++;
    if (this.failedAttempts >= 5) {
      this.lockoutUntil = Date.now() + 30000; // 30 sec cooldown
    }
    return false;
  }

  private rememberPinLength(length: number) {
    this.pinLength = length;
    localStorage.setItem(STORAGE_KEYS.PIN_LENGTH, String(length));
  }

  isLockedOut(): boolean {
    if (this.lockoutUntil > 0) {
      if (Date.now() < this.lockoutUntil) return true;
      this.lockoutUntil = 0;
      this.failedAttempts = 0;
    }
    return false;
  }

  lockoutSecondsRemaining(): number {
    if (!this.isLockedOut()) return 0;
    return Math.max(0, Math.ceil((this.lockoutUntil - Date.now()) / 1000));
  }

  async registerBiometrics(): Promise<boolean> {
    if (!this.biometricsSupported) return false;
    try {
      const challenge = crypto.getRandomValues(new Uint8Array(32));
      const userId = crypto.getRandomValues(new Uint8Array(16));

      const cred = (await navigator.credentials.create({
        publicKey: {
          challenge,
          rp: { name: 'Tech Lead Cockpit', id: window.location.hostname },
          user: {
            id: userId,
            name: 'techlead',
            displayName: 'Tech Lead Cockpit User',
          },
          pubKeyCredParams: [
            { alg: -7, type: 'public-key' },
            { alg: -257, type: 'public-key' },
          ],
          authenticatorSelection: {
            authenticatorAttachment: 'platform',
            userVerification: 'required',
            residentKey: 'preferred',
          },
          timeout: 60000,
        },
      })) as PublicKeyCredential | null;

      if (cred) {
        localStorage.setItem(STORAGE_KEYS.CREDENTIAL_ID, bytesToHex(new Uint8Array(cred.rawId)));
        localStorage.setItem(STORAGE_KEYS.BIOMETRICS_ENABLED, 'true');
        this.biometricsEnabled = true;
        return true;
      }
    } catch (e: any) {
      console.warn('WebAuthn registration error:', e);
    }
    return false;
  }

  async verifyBiometrics(): Promise<boolean> {
    if (!this.biometricsEnabled || typeof window === 'undefined' || !navigator.credentials) {
      return false;
    }
    if (this.isLockedOut()) return false;

    try {
      const credIdHex = localStorage.getItem(STORAGE_KEYS.CREDENTIAL_ID);
      const challenge = crypto.getRandomValues(new Uint8Array(32));
      const allowCredentials: PublicKeyCredentialDescriptor[] = credIdHex
        ? [{ id: hexToBytes(credIdHex).buffer as ArrayBuffer, type: 'public-key' }]
        : [];

      const assertion = await navigator.credentials.get({
        publicKey: {
          challenge,
          rpId: window.location.hostname,
          allowCredentials,
          userVerification: 'required',
          timeout: 60000,
        },
      });

      if (assertion) {
        this.failedAttempts = 0;
        this.unlock();
        return true;
      }
    } catch (err: any) {
      console.warn('Touch ID verification failed/canceled:', err);
    }
    return false;
  }

  disableBiometrics() {
    localStorage.removeItem(STORAGE_KEYS.BIOMETRICS_ENABLED);
    localStorage.removeItem(STORAGE_KEYS.CREDENTIAL_ID);
    this.biometricsEnabled = false;
  }

  async changePin(oldPin: string, newPin: string): Promise<{ success: boolean; error?: string }> {
    const saltHex = localStorage.getItem(STORAGE_KEYS.PIN_SALT);
    const expectedHash = localStorage.getItem(STORAGE_KEYS.PIN_HASH);
    if (!saltHex || !expectedHash) {
      return { success: false, error: 'PIN belum dikonfigurasi.' };
    }

    const salt = hexToBytes(saltHex);
    const oldHash = await hashPin(oldPin, salt);
    if (oldHash !== expectedHash) {
      return { success: false, error: 'PIN lama salah.' };
    }

    if (!new RegExp(`^\\d{${PIN_MIN},${PIN_MAX}}$`).test(newPin)) {
      return { success: false, error: `PIN baru harus ${PIN_MIN}–${PIN_MAX} angka.` };
    }

    const newSalt = crypto.getRandomValues(new Uint8Array(16));
    const newHash = await hashPin(newPin, newSalt);
    localStorage.setItem(STORAGE_KEYS.PIN_SALT, bytesToHex(newSalt));
    localStorage.setItem(STORAGE_KEYS.PIN_HASH, newHash);
    this.rememberPinLength(newPin.length);
    return { success: true };
  }

  setAutoLock(seconds: number) {
    this.autoLockSeconds = seconds;
    localStorage.setItem(STORAGE_KEYS.AUTOLOCK_SECONDS, String(seconds));
  }

  lock() {
    this.isUnlocked = false;
    sessionStorage.removeItem(STORAGE_KEYS.SESSION_UNLOCKED);
    sessionStorage.removeItem(STORAGE_KEYS.LAST_ACTIVITY);
  }

  unlock() {
    this.isUnlocked = true;
    this.failedAttempts = 0;
    this.lockoutUntil = 0;
    sessionStorage.setItem(STORAGE_KEYS.SESSION_UNLOCKED, 'true');
    this.recordActivity();
  }

  resetAll() {
    localStorage.removeItem(STORAGE_KEYS.PIN_HASH);
    localStorage.removeItem(STORAGE_KEYS.PIN_SALT);
    localStorage.removeItem(STORAGE_KEYS.BIOMETRICS_ENABLED);
    localStorage.removeItem(STORAGE_KEYS.CREDENTIAL_ID);
    localStorage.removeItem(STORAGE_KEYS.AUTOLOCK_SECONDS);
    localStorage.removeItem(STORAGE_KEYS.PIN_LENGTH);
    this.pinLength = 0;
    this.isConfigured = false;
    this.biometricsEnabled = false;
    this.lock();
  }
}

export const security = new SecurityStore();
