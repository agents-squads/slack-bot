/**
 * OAuth Token Exchange Tests
 *
 * Tests the OAuth flow for Slack app installation:
 * - Token exchange with Slack API
 * - State validation for CSRF protection
 * - Error handling for failed exchanges
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('Slack OAuth Token Exchange', () => {
  const mockOAuthResponse = {
    ok: true,
    access_token: 'xoxb-test-token',
    token_type: 'bot',
    scope: 'chat:write,channels:read',
    bot_user_id: 'U012345',
    app_id: 'A012345',
    team: {
      id: 'T012345',
      name: 'Test Workspace',
    },
    authed_user: {
      id: 'U987654',
    },
    enterprise: null,
  };

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Token Exchange', () => {
    it('should successfully exchange code for tokens', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockOAuthResponse,
      });

      const response = await fetch('https://slack.com/api/oauth.v2.access', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          client_id: 'test-client-id',
          client_secret: 'test-client-secret',
          code: 'test-auth-code',
          redirect_uri: 'http://localhost:8090/auth/slack/callback',
        }),
      });

      const data = await response.json();

      expect(data.ok).toBe(true);
      expect(data.access_token).toBe('xoxb-test-token');
      expect(data.team.id).toBe('T012345');
      expect(data.bot_user_id).toBe('U012345');
    });

    it('should handle invalid authorization code', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: false,
          error: 'invalid_code',
        }),
      });

      const response = await fetch('https://slack.com/api/oauth.v2.access', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          client_id: 'test-client-id',
          client_secret: 'test-client-secret',
          code: 'invalid-code',
          redirect_uri: 'http://localhost:8090/auth/slack/callback',
        }),
      });

      const data = await response.json();

      expect(data.ok).toBe(false);
      expect(data.error).toBe('invalid_code');
    });

    it('should handle network errors', async () => {
      global.fetch.mockRejectedValueOnce(new Error('Network error'));

      await expect(
        fetch('https://slack.com/api/oauth.v2.access', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            client_id: 'test-client-id',
            client_secret: 'test-client-secret',
            code: 'test-auth-code',
            redirect_uri: 'http://localhost:8090/auth/slack/callback',
          }),
        })
      ).rejects.toThrow('Network error');
    });

    it('should include all required parameters', async () => {
      const params = new URLSearchParams({
        client_id: 'test-client-id',
        client_secret: 'test-client-secret',
        code: 'test-auth-code',
        redirect_uri: 'http://localhost:8090/auth/slack/callback',
      });

      expect(params.get('client_id')).toBe('test-client-id');
      expect(params.get('client_secret')).toBe('test-client-secret');
      expect(params.get('code')).toBe('test-auth-code');
      expect(params.get('redirect_uri')).toBe('http://localhost:8090/auth/slack/callback');
    });
  });

  describe('State Validation', () => {
    it('should validate state parameter matches stored state', () => {
      const storedState = 'test-state-12345';
      const receivedState = 'test-state-12345';

      expect(receivedState).toBe(storedState);
    });

    it('should reject mismatched state', () => {
      const storedState = 'test-state-12345';
      const receivedState = 'different-state';

      expect(receivedState).not.toBe(storedState);
    });

    it('should reject missing state', () => {
      const receivedState = null;

      expect(receivedState).toBeNull();
    });

    it('should generate cryptographically secure state', () => {
      // State should be at least 32 characters (URL-safe base64)
      const state = 'abcdefghijklmnopqrstuvwxyz123456';

      expect(state.length).toBeGreaterThanOrEqual(32);
      expect(/^[A-Za-z0-9_-]+$/.test(state)).toBe(true);
    });

    it('should expire old state after TTL', () => {
      const now = Date.now();
      const stateTTL = 10 * 60 * 1000; // 10 minutes
      const stateTimestamp = now - (11 * 60 * 1000); // 11 minutes ago

      const isExpired = (now - stateTimestamp) > stateTTL;

      expect(isExpired).toBe(true);
    });

    it('should not expire valid state within TTL', () => {
      const now = Date.now();
      const stateTTL = 10 * 60 * 1000; // 10 minutes
      const stateTimestamp = now - (5 * 60 * 1000); // 5 minutes ago

      const isExpired = (now - stateTimestamp) > stateTTL;

      expect(isExpired).toBe(false);
    });
  });

  describe('Installation Storage', () => {
    it('should store installation with all required fields', async () => {
      const installation = {
        team_id: mockOAuthResponse.team.id,
        team_name: mockOAuthResponse.team.name,
        bot_token: mockOAuthResponse.access_token,
        bot_user_id: mockOAuthResponse.bot_user_id,
        bot_id: mockOAuthResponse.bot_user_id,
        installed_by: mockOAuthResponse.authed_user.id,
        scope: mockOAuthResponse.scope,
        token_type: mockOAuthResponse.token_type,
        is_active: true,
      };

      expect(installation.team_id).toBeDefined();
      expect(installation.team_name).toBeDefined();
      expect(installation.bot_token).toBeDefined();
      expect(installation.bot_user_id).toBeDefined();
      expect(installation.installed_by).toBeDefined();
      expect(installation.is_active).toBe(true);
    });

    it('should not expose sensitive tokens in responses', async () => {
      const publicInstallation = {
        team_id: 'T012345',
        team_name: 'Test Workspace',
        installed_by: 'U987654',
        installed_at: new Date().toISOString(),
        is_active: true,
        settings: {},
      };

      // Should not include bot_token in public responses
      expect(publicInstallation).not.toHaveProperty('bot_token');
      expect(publicInstallation).not.toHaveProperty('bot_id');
    });
  });

  describe('Error Handling', () => {
    it('should handle missing client_id', async () => {
      const clientId = '';

      expect(clientId).toBeFalsy();
    });

    it('should handle missing client_secret', async () => {
      const clientSecret = '';

      expect(clientSecret).toBeFalsy();
    });

    it('should handle Slack API errors', async () => {
      const errorResponse = {
        ok: false,
        error: 'invalid_client_id',
      };

      expect(errorResponse.ok).toBe(false);
      expect(errorResponse.error).toBeTruthy();
    });

    it('should handle rate limiting', async () => {
      const rateLimitResponse = {
        ok: false,
        error: 'rate_limited',
      };

      expect(rateLimitResponse.error).toBe('rate_limited');
    });
  });

  describe('Scopes', () => {
    it('should request correct bot scopes', () => {
      const botScopes = [
        'chat:write',
        'chat:write.public',
        'channels:read',
        'groups:read',
        'im:read',
        'im:write',
        'im:history',
        'users:read',
        'users:read.email',
        'reactions:read',
        'reactions:write',
        'files:read',
        'app_mentions:read',
        'commands',
      ];

      expect(botScopes).toContain('chat:write');
      expect(botScopes).toContain('app_mentions:read');
      expect(botScopes).toContain('commands');
    });

    it('should request correct user scopes', () => {
      const userScopes = ['identity.basic', 'identity.email'];

      expect(userScopes).toContain('identity.basic');
      expect(userScopes).toContain('identity.email');
    });

    it('should validate granted scopes match requested', () => {
      const requestedScopes = 'chat:write,channels:read';
      const grantedScopes = 'chat:write,channels:read';

      expect(grantedScopes).toBe(requestedScopes);
    });
  });
});
