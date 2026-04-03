-- Add new paid tiers for the 5-tier pricing model.
ALTER TYPE "OrganizationPlan" ADD VALUE IF NOT EXISTS 'PRO';
ALTER TYPE "OrganizationPlan" ADD VALUE IF NOT EXISTS 'SCALE';
