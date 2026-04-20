-- Migration: Replace Google OIDC auth with email/password auth
-- Drops googleId, adds email + passwordHash to User table

-- Step 1: Add new columns (nullable initially for safety)
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "email" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "passwordHash" TEXT;

-- Step 2: Drop old Google-specific columns
ALTER TABLE "User" DROP COLUMN IF EXISTS "googleId";
ALTER TABLE "User" DROP COLUMN IF EXISTS "picture";

-- Step 3: Make new columns required and add unique constraint
ALTER TABLE "User" ALTER COLUMN "email" SET NOT NULL;
ALTER TABLE "User" ALTER COLUMN "passwordHash" SET NOT NULL;

-- Step 4: Add unique index on email
CREATE UNIQUE INDEX IF NOT EXISTS "User_email_key" ON "User"("email");
