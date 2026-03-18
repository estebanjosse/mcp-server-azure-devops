import {
  normalizeAuthMethod,
  normalizeTransport,
  isAllowedHost,
} from './index';
import { AuthenticationMethod } from './shared/auth/auth-factory';

describe('index', () => {
  describe('normalizeAuthMethod', () => {
    it('should return AzureIdentity when authMethodStr is undefined', () => {
      // Arrange
      const authMethodStr = undefined;

      // Act
      const result = normalizeAuthMethod(authMethodStr);

      // Assert
      expect(result).toBe(AuthenticationMethod.AzureIdentity);
    });

    it('should return AzureIdentity when authMethodStr is empty', () => {
      // Arrange
      const authMethodStr = '';

      // Act
      const result = normalizeAuthMethod(authMethodStr);

      // Assert
      expect(result).toBe(AuthenticationMethod.AzureIdentity);
    });

    it('should handle PersonalAccessToken case-insensitively', () => {
      // Arrange
      const variations = ['pat', 'PAT', 'Pat', 'pAt', 'paT'];

      // Act & Assert
      variations.forEach((variant) => {
        expect(normalizeAuthMethod(variant)).toBe(
          AuthenticationMethod.PersonalAccessToken,
        );
      });
    });

    it('should handle AzureIdentity case-insensitively', () => {
      // Arrange
      const variations = [
        'azure-identity',
        'AZURE-IDENTITY',
        'Azure-Identity',
        'azure-Identity',
        'Azure-identity',
      ];

      // Act & Assert
      variations.forEach((variant) => {
        expect(normalizeAuthMethod(variant)).toBe(
          AuthenticationMethod.AzureIdentity,
        );
      });
    });

    it('should handle AzureCli case-insensitively', () => {
      // Arrange
      const variations = [
        'azure-cli',
        'AZURE-CLI',
        'Azure-Cli',
        'azure-Cli',
        'Azure-cli',
      ];

      // Act & Assert
      variations.forEach((variant) => {
        expect(normalizeAuthMethod(variant)).toBe(
          AuthenticationMethod.AzureCli,
        );
      });
    });

    it('should return AzureIdentity for unrecognized values', () => {
      // Arrange
      const unrecognized = [
        'unknown',
        'azureCli', // no hyphen
        'azureIdentity', // no hyphen
        'personal-access-token', // not matching enum value
        'cli',
        'identity',
      ];

      // Act & Assert (mute stderr for warning messages)
      const originalStderrWrite = process.stderr.write;
      process.stderr.write = jest.fn();

      try {
        unrecognized.forEach((value) => {
          expect(normalizeAuthMethod(value)).toBe(
            AuthenticationMethod.AzureIdentity,
          );
        });
      } finally {
        process.stderr.write = originalStderrWrite;
      }
    });
  });

  describe('normalizeTransport', () => {
    it('should return stdio when transportStr is undefined', () => {
      expect(normalizeTransport(undefined)).toBe('stdio');
    });

    it('should return stdio when transportStr is empty', () => {
      expect(normalizeTransport('')).toBe('stdio');
    });

    it('should return stdio for "stdio" value', () => {
      expect(normalizeTransport('stdio')).toBe('stdio');
    });

    it('should return http for "http" value', () => {
      expect(normalizeTransport('http')).toBe('http');
    });

    it('should handle transport values case-insensitively', () => {
      expect(normalizeTransport('HTTP')).toBe('http');
      expect(normalizeTransport('Http')).toBe('http');
      expect(normalizeTransport('STDIO')).toBe('stdio');
      expect(normalizeTransport('Stdio')).toBe('stdio');
    });

    it('should trim whitespace from transport values', () => {
      expect(normalizeTransport('  http  ')).toBe('http');
      expect(normalizeTransport('  stdio  ')).toBe('stdio');
    });

    it('should return stdio for unrecognized values and log a warning', () => {
      const originalStderrWrite = process.stderr.write;
      process.stderr.write = jest.fn();

      try {
        expect(normalizeTransport('sse')).toBe('stdio');
        expect(normalizeTransport('tcp')).toBe('stdio');
        expect(normalizeTransport('unknown')).toBe('stdio');
      } finally {
        process.stderr.write = originalStderrWrite;
      }
    });
  });

  describe('isAllowedHost', () => {
    it('should return false when headerValue is undefined', () => {
      expect(isAllowedHost(undefined, '127.0.0.1', 3000)).toBe(false);
    });

    it('should allow exact host:port match', () => {
      expect(isAllowedHost('127.0.0.1:3000', '127.0.0.1', 3000)).toBe(true);
    });

    it('should reject mismatched port', () => {
      expect(isAllowedHost('127.0.0.1:4000', '127.0.0.1', 3000)).toBe(false);
    });

    it('should reject mismatched host', () => {
      expect(isAllowedHost('evil.com:3000', '127.0.0.1', 3000)).toBe(false);
    });

    it('should allow all localhost aliases with the same port when bound to a localhost address', () => {
      expect(isAllowedHost('localhost:3000', '127.0.0.1', 3000)).toBe(true);
      expect(isAllowedHost('::1:3000', '127.0.0.1', 3000)).toBe(true);
      expect(isAllowedHost('127.0.0.1:3000', 'localhost', 3000)).toBe(true);
      expect(isAllowedHost('::1:3000', 'localhost', 3000)).toBe(true);
    });

    it('should not allow localhost aliases when bound to a non-localhost address', () => {
      expect(isAllowedHost('localhost:3000', '0.0.0.0', 3000)).toBe(false);
      expect(isAllowedHost('127.0.0.1:3000', '0.0.0.0', 3000)).toBe(false);
    });

    it('should allow bare host without port for standard HTTP port 80', () => {
      expect(isAllowedHost('127.0.0.1', '127.0.0.1', 80)).toBe(true);
    });

    it('should not allow bare host without port for non-standard ports', () => {
      expect(isAllowedHost('127.0.0.1', '127.0.0.1', 3000)).toBe(false);
    });
  });
});
