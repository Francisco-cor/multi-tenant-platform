import { describe, expect, it } from 'vitest';
import { InMemoryIdentityStore } from './identity-store.js';

describe('in-memory identity boundary', () => {
  it('does not consume an invitation for the wrong tenant and accepts it once', () => {
    const store = new InMemoryIdentityStore(true);
    const invitee = store.upsertOidcUser({
      subject: 'new-user',
      issuer: 'http://localhost:5556/dex',
      email: 'invitee@example.test',
      displayName: 'Invitee',
    });
    const created = store.createInvitation({
      organizationId: 'tenant-acme',
      email: invitee.email,
      role: 'operator',
      invitedBy: 'user-alice',
    });

    expect(() =>
      store.acceptInvitation({
        rawToken: created.rawToken,
        userId: invitee.id,
        email: invitee.email,
        expectedOrganizationId: 'tenant-contoso',
      }),
    ).toThrow('invitation_invalid');
    expect(store.listMembershipsForOrganization('tenant-contoso')).not.toContainEqual(
      expect.objectContaining({ userId: invitee.id }),
    );

    const accepted = store.acceptInvitation({
      rawToken: created.rawToken,
      userId: invitee.id,
      email: invitee.email,
      expectedOrganizationId: 'tenant-acme',
    });
    expect(accepted.acceptedAt).toBeDefined();
    expect(() =>
      store.acceptInvitation({
        rawToken: created.rawToken,
        userId: invitee.id,
        email: invitee.email,
        expectedOrganizationId: 'tenant-acme',
      }),
    ).toThrow('invitation_invalid');
  });

  it('stops authorizing a removed membership', () => {
    const store = new InMemoryIdentityStore(true);
    store.removeMembership('membership-acme-only');
    expect(store.getActiveMembership('user-acme-only', 'tenant-acme')).toBeNull();
  });
});
