class PasswordPromptState {
  open = $state(false);
  fileName = $state('');
  invalid = $state(false);
  private resolveFn?: (value: string | undefined) => void;

  ask(fileName: string, invalid: boolean): Promise<string | undefined> {
    this.resolveFn?.(undefined);
    this.fileName = fileName;
    this.invalid = invalid;
    this.open = true;
    return new Promise((resolve) => {
      this.resolveFn = resolve;
    });
  }

  submit(password: string) {
    this.finish(password);
  }

  cancel() {
    this.finish(undefined);
  }

  private finish(value: string | undefined) {
    this.open = false;
    const fn = this.resolveFn;
    this.resolveFn = undefined;
    fn?.(value);
  }
}

export const passwordPromptState = new PasswordPromptState();
/** Resolves with the password, or undefined when the user skips the file. */
export const askPdfPassword = (fileName: string, invalid = false) => passwordPromptState.ask(fileName, invalid);
