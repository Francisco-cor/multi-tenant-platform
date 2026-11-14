export interface ApiErrorBody {
  error?: {
    code?: string;
    message?: string;
    requestId?: string;
    details?: Record<string, unknown>;
  };
}

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  status: string;
}

export interface OrganizationSummary {
  id: string;
  slug: string;
  name: string;
  status: string;
  role?: string;
}

export interface AuthMe {
  user: SessionUser;
  organizations: OrganizationSummary[];
  selectedOrganizationId: string | null;
}

export interface TenantContext {
  requestId: string;
  user: SessionUser;
  organization: OrganizationSummary;
  membership: {
    id: string;
    userId: string;
    email?: string;
    displayName?: string;
    role: string;
    status: string;
  };
  roles: string[];
  permissions: string[];
}

export interface Branch {
  id: string;
  slug: string;
  name: string;
  description?: string;
  status: string;
}

export interface Order {
  id: string;
  branchId: string;
  status: string;
  amountCents: number;
  currency: string;
  createdAt: number;
}

export interface InventoryItem {
  productId: string;
  sku: string;
  name: string;
  branchId: string;
  available: number;
}

export interface InventoryReservation {
  id: string;
  branchId: string;
  productId: string;
  quantity: number;
  status: string;
  expiresAt: number;
}

export interface FileRecord {
  id: string;
  filename: string;
  contentType: string;
  sizeExpected: number;
  sizeActual?: number | null;
  status: string;
  createdAt: number;
}

export interface Member {
  id: string;
  userId: string;
  email?: string;
  displayName?: string;
  role: string;
  status: string;
}

export interface PresignedUpload {
  file: FileRecord;
  upload: {
    url: string;
    expiresAt: number;
    headers: Record<string, string>;
    key?: string;
  };
}
