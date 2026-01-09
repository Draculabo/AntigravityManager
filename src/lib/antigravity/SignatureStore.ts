/**
 * Global thought_signature storage shared by all endpoints
 * Used to capture and replay signatures for Gemini 3+ function calls when clients don't pass them back.
 */

class SignatureStoreImpl {
  private static instance: SignatureStoreImpl;
  private signature: string | null = null;

  private constructor() {}

  public static getInstance(): SignatureStoreImpl {
    if (!SignatureStoreImpl.instance) {
      SignatureStoreImpl.instance = new SignatureStoreImpl();
    }
    return SignatureStoreImpl.instance;
  }

  /**
   * Store thought_signature to global storage.
   * Only stores if the new signature is longer than the existing one,
   * to avoid short/partial signatures overwriting valid ones.
   */
  public store(sig: string) {
    if (!sig) return;

    const existingLen = this.signature ? this.signature.length : 0;
    const newLen = sig.length;

    if (newLen > existingLen) {
      console.log(
        `[ThoughtSig] Storing new signature (length: ${newLen}, replacing old: ${existingLen})`,
      );
      this.signature = sig;
    } else {
      console.debug(
        `[ThoughtSig] Skipping shorter signature (new length: ${newLen}, existing: ${existingLen})`,
      );
    }
  }

  /**
   * Get the stored thought_signature without clearing it.
   */
  public get(): string | null {
    return this.signature;
  }

  /**
   * Get and clear the stored thought_signature.
   */
  public take(): string | null {
    const sig = this.signature;
    this.signature = null;
    return sig;
  }

  /**
   * Clear the stored thought_signature.
   */
  public clear() {
    this.signature = null;
  }
}

export const SignatureStore = SignatureStoreImpl.getInstance();
