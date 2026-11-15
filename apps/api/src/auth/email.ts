export interface TransactionalEmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface EmailProvider {
  send(message: TransactionalEmailMessage): Promise<void>;
}

/**
 * Development email provider that writes safe metadata (recipient & subject—never raw tokens or journal content)
 * to console/structured output, while keeping sent messages inspectable in tests if needed.
 */
export class ConsoleEmailProvider implements EmailProvider {
  public readonly sentMessages: TransactionalEmailMessage[] = [];
  private readonly logFn: (info: { to: string; subject: string }) => void;

  constructor(
    logFn: (info: { to: string; subject: string }) => void = (info) => {
      if (process.env.NODE_ENV !== 'test') {
        console.info(`[DevEmailProvider] To=${info.to} Subject="${info.subject}"`);
      }
    },
  ) {
    this.logFn = logFn;
  }

  public async send(message: TransactionalEmailMessage): Promise<void> {
    this.sentMessages.push(message);
    this.logFn({ to: message.to, subject: message.subject });
  }
}

export function buildVerificationEmail(params: {
  to: string;
  appBaseUrl: string;
  rawToken: string;
}): TransactionalEmailMessage {
  const verifyUrl = `${params.appBaseUrl.replace(/\/$/, '')}/verify-email?token=${encodeURIComponent(params.rawToken)}`;

  return {
    to: params.to,
    subject: 'Verify your Morning Pages email address',
    text: [
      'Welcome to Morning Pages.',
      '',
      'Please verify your email address within 24 hours by opening the link below:',
      verifyUrl,
      '',
      'If you did not create an account, you can safely ignore this email.',
    ].join('\n'),
    html: [
      '<p>Welcome to <strong>Morning Pages</strong>.</p>',
      '<p>Please verify your email address within 24 hours by clicking the link below:</p>',
      `<p><a href="${verifyUrl}">Verify email address</a></p>`,
      '<p>If you did not create an account, you can safely ignore this email.</p>',
    ].join('\n'),
  };
}

export function buildPasswordResetEmail(params: {
  to: string;
  appBaseUrl: string;
  rawToken: string;
}): TransactionalEmailMessage {
  const resetUrl = `${params.appBaseUrl.replace(/\/$/, '')}/reset-password?token=${encodeURIComponent(params.rawToken)}`;

  return {
    to: params.to,
    subject: 'Reset your Morning Pages password',
    text: [
      'We received a request to reset your Morning Pages password.',
      '',
      'Use the link below within 1 hour to choose a new password:',
      resetUrl,
      '',
      'If you did not request a password reset, no action is needed.',
    ].join('\n'),
    html: [
      '<p>We received a request to reset your <strong>Morning Pages</strong> password.</p>',
      '<p>Use the link below within 1 hour to choose a new password:</p>',
      `<p><a href="${resetUrl}">Reset password</a></p>`,
      '<p>If you did not request a password reset, no action is needed.</p>',
    ].join('\n'),
  };
}
