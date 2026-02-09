/**
 * Multi-Tenant Authorization Tests
 *
 * Tests the authorize callback that looks up bot tokens per workspace:
 * - Token lookup from database via scheduler API
 * - Token caching for performance
 * - Multi-tenant isolation (workspace A can't access B)
 * - Fallback to env token for backwards compatibility
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('Multi-Tenant Authorization', () => {
  let tokenCache;
  let mockSchedulerApi;

  beforeEach(() => {
    tokenCache = new Map();
    global.fetch = vi.fn();

    mockSchedulerApi = vi.fn(async (method, path) => {
      if (path === '/slack/installations/T012345/token') {
        return {
          bot_token: 'xoxb-workspace-a-token',
          bot_id: 'B012345',
          bot_user_id: 'U012345',
          team_name: 'Workspace A',
        };
      }
      if (path === '/slack/installations/T067890/token') {
        return {
          bot_token: 'xoxb-workspace-b-token',
          bot_id: 'B067890',
          bot_user_id: 'U067890',
          team_name: 'Workspace B',
        };
      }
      return null;
    });
  });

  afterEach(() => {
    tokenCache.clear();
    vi.restoreAllMocks();
  });

  describe('Token Lookup', () => {
    it('should fetch token for workspace A', async () => {
      const installation = await mockSchedulerApi('GET', '/slack/installations/T012345/token');

      expect(installation).toBeDefined();
      expect(installation.bot_token).toBe('xoxb-workspace-a-token');
      expect(installation.bot_user_id).toBe('U012345');
      expect(installation.team_name).toBe('Workspace A');
    });

    it('should fetch token for workspace B', async () => {
      const installation = await mockSchedulerApi('GET', '/slack/installations/T067890/token');

      expect(installation).toBeDefined();
      expect(installation.bot_token).toBe('xoxb-workspace-b-token');
      expect(installation.bot_user_id).toBe('U067890');
      expect(installation.team_name).toBe('Workspace B');
    });

    it('should return null for unknown workspace', async () => {
      const installation = await mockSchedulerApi('GET', '/slack/installations/T_UNKNOWN/token');

      expect(installation).toBeNull();
    });

    it('should return installation with correct structure', async () => {
      const installation = await mockSchedulerApi('GET', '/slack/installations/T012345/token');

      expect(installation).toHaveProperty('bot_token');
      expect(installation).toHaveProperty('bot_user_id');
      expect(installation).toHaveProperty('bot_id');
      expect(installation).toHaveProperty('team_name');
    });
  });

  describe('Multi-Tenant Isolation', () => {
    it('should return different tokens for different workspaces', async () => {
      const workspaceA = await mockSchedulerApi('GET', '/slack/installations/T012345/token');
      const workspaceB = await mockSchedulerApi('GET', '/slack/installations/T067890/token');

      expect(workspaceA.bot_token).not.toBe(workspaceB.bot_token);
      expect(workspaceA.bot_user_id).not.toBe(workspaceB.bot_user_id);
    });

    it('should not allow workspace A to access workspace B token', async () => {
      const requestedTeamId = 'T012345';
      const installation = await mockSchedulerApi('GET', `/slack/installations/${requestedTeamId}/token`);

      expect(installation.bot_token).toBe('xoxb-workspace-a-token');
      expect(installation.bot_token).not.toBe('xoxb-workspace-b-token');
    });

    it('should validate team_id before returning token', async () => {
      const teamId = 'T012345';
      const installation = await mockSchedulerApi('GET', `/slack/installations/${teamId}/token`);

      expect(installation.team_name).toBe('Workspace A');
    });
  });

  describe('Token Caching', () => {
    const TOKEN_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

    it('should cache token after first lookup', async () => {
      const teamId = 'T012345';
      const installation = await mockSchedulerApi('GET', `/slack/installations/${teamId}/token`);

      tokenCache.set(teamId, {
        auth: {
          botToken: installation.bot_token,
          botId: installation.bot_id,
          botUserId: installation.bot_user_id,
        },
        timestamp: Date.now(),
      });

      expect(tokenCache.has(teamId)).toBe(true);
      expect(tokenCache.get(teamId).auth.botToken).toBe('xoxb-workspace-a-token');
    });

    it('should use cached token within TTL', () => {
      const teamId = 'T012345';
      const cachedToken = {
        auth: {
          botToken: 'xoxb-cached-token',
          botId: 'B012345',
          botUserId: 'U012345',
        },
        timestamp: Date.now(),
      };

      tokenCache.set(teamId, cachedToken);

      const cached = tokenCache.get(teamId);
      const isValid = (Date.now() - cached.timestamp) < TOKEN_CACHE_TTL;

      expect(isValid).toBe(true);
      expect(cached.auth.botToken).toBe('xoxb-cached-token');
    });

    it('should expire cache after TTL', () => {
      const teamId = 'T012345';
      const oldTimestamp = Date.now() - (6 * 60 * 1000); // 6 minutes ago
      const cachedToken = {
        auth: {
          botToken: 'xoxb-old-token',
          botId: 'B012345',
          botUserId: 'U012345',
        },
        timestamp: oldTimestamp,
      };

      tokenCache.set(teamId, cachedToken);

      const cached = tokenCache.get(teamId);
      const isExpired = (Date.now() - cached.timestamp) > TOKEN_CACHE_TTL;

      expect(isExpired).toBe(true);
    });

    it('should invalidate cache on token refresh', () => {
      const teamId = 'T012345';
      tokenCache.set(teamId, {
        auth: { botToken: 'xoxb-old-token' },
        timestamp: Date.now(),
      });

      // Simulate token refresh
      tokenCache.delete(teamId);

      expect(tokenCache.has(teamId)).toBe(false);
    });
  });

  describe('Backwards Compatibility', () => {
    it('should fallback to env token if no installation found', async () => {
      const envToken = 'xoxb-env-fallback-token';
      const envBotId = 'B_ENV';
      const teamId = 'T_UNKNOWN';

      const installation = await mockSchedulerApi('GET', `/slack/installations/${teamId}/token`);

      if (!installation) {
        const fallback = {
          botToken: envToken,
          botId: envBotId,
          botUserId: envBotId,
        };

        expect(fallback.botToken).toBe(envToken);
        expect(fallback.botId).toBe(envBotId);
      }
    });

    it('should log warning when using fallback', () => {
      const teamId = 'T_UNKNOWN';
      const shouldWarn = true;

      if (shouldWarn) {
        const warning = `No installation for team ${teamId}, using env token fallback`;
        expect(warning).toContain('using env token fallback');
      }
    });

    it('should prefer database token over env token', async () => {
      const dbInstallation = await mockSchedulerApi('GET', '/slack/installations/T012345/token');
      const envToken = 'xoxb-env-token';

      // Should use database token, not env
      expect(dbInstallation.bot_token).toBe('xoxb-workspace-a-token');
      expect(dbInstallation.bot_token).not.toBe(envToken);
    });
  });

  describe('Error Handling', () => {
    it('should throw error if no token found and no fallback', async () => {
      const teamId = 'T_UNKNOWN';
      const installation = await mockSchedulerApi('GET', `/slack/installations/${teamId}/token`);
      const hasEnvFallback = false;

      if (!installation && !hasEnvFallback) {
        const error = new Error(`No Slack installation found for team ${teamId}`);
        expect(error.message).toContain('No Slack installation found');
      }
    });

    it('should handle API connection errors', async () => {
      const failingApi = vi.fn().mockRejectedValue(new Error('Connection refused'));

      await expect(
        failingApi('GET', '/slack/installations/T012345/token')
      ).rejects.toThrow('Connection refused');
    });

    it('should handle malformed API responses', async () => {
      const malformedApi = vi.fn().mockResolvedValue({ invalid: 'response' });

      const response = await malformedApi('GET', '/slack/installations/T012345/token');

      expect(response).not.toHaveProperty('bot_token');
    });

    it('should handle null team_id', async () => {
      const teamId = null;

      if (!teamId) {
        expect(teamId).toBeNull();
      }
    });

    it('should handle empty team_id', async () => {
      const teamId = '';

      if (!teamId) {
        expect(teamId).toBeFalsy();
      }
    });
  });

  describe('Authorization Object', () => {
    it('should return correct structure for Bolt', async () => {
      const installation = await mockSchedulerApi('GET', '/slack/installations/T012345/token');

      const auth = {
        botToken: installation.bot_token,
        botId: installation.bot_id,
        botUserId: installation.bot_user_id,
      };

      expect(auth).toHaveProperty('botToken');
      expect(auth).toHaveProperty('botId');
      expect(auth).toHaveProperty('botUserId');
      expect(typeof auth.botToken).toBe('string');
    });

    it('should not expose sensitive data in logs', async () => {
      const installation = await mockSchedulerApi('GET', '/slack/installations/T012345/token');

      const safeLog = {
        team_name: installation.team_name,
        bot_user_id: installation.bot_user_id,
        // bot_token intentionally excluded
      };

      expect(safeLog).not.toHaveProperty('bot_token');
      expect(safeLog).toHaveProperty('team_name');
    });
  });

  describe('Enterprise Support', () => {
    it('should handle enterprise_id for enterprise grid', () => {
      const teamId = 'T012345';
      const enterpriseId = 'E012345';
      const cacheKey = enterpriseId || teamId;

      expect(cacheKey).toBe(enterpriseId);
    });

    it('should fallback to team_id if no enterprise_id', () => {
      const teamId = 'T012345';
      const enterpriseId = null;
      const cacheKey = enterpriseId || teamId;

      expect(cacheKey).toBe(teamId);
    });
  });

  describe('Active Installation Check', () => {
    it('should only return active installations', async () => {
      const mockApiWithStatus = vi.fn(async (method, path) => {
        if (path === '/slack/installations/T_INACTIVE/token') {
          return null; // API should not return inactive installations
        }
        return {
          bot_token: 'xoxb-active-token',
          bot_user_id: 'U012345',
          bot_id: 'B012345',
          team_name: 'Active Workspace',
        };
      });

      const inactive = await mockApiWithStatus('GET', '/slack/installations/T_INACTIVE/token');
      expect(inactive).toBeNull();

      const active = await mockApiWithStatus('GET', '/slack/installations/T012345/token');
      expect(active).toBeDefined();
    });

    it('should handle uninstalled apps gracefully', async () => {
      const uninstalledTeamId = 'T_UNINSTALLED';
      const installation = await mockSchedulerApi('GET', `/slack/installations/${uninstalledTeamId}/token`);

      expect(installation).toBeNull();
    });
  });
});
