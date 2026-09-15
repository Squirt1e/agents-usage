import { redactSecrets } from '../shared/redaction';

export function createSafeLogger(sink: (line: string) => void) {
  return {
    error(message: string, details?: unknown) {
      sink(JSON.stringify(redactSecrets({ level: 'error', message, details })));
    },
    info(message: string, details?: unknown) {
      sink(JSON.stringify(redactSecrets({ level: 'info', message, details })));
    }
  };
}
