-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "ContainerType" AS ENUM ('workspace', 'space', 'folder', 'list');

-- CreateEnum
CREATE TYPE "Visibility" AS ENUM ('public', 'private');

-- CreateEnum
CREATE TYPE "GrantMode" AS ENUM ('allow', 'deny');

-- CreateEnum
CREATE TYPE "StatusCategory" AS ENUM ('not_started', 'active', 'done', 'closed');

-- CreateEnum
CREATE TYPE "FieldType" AS ENUM ('text', 'number', 'single_select', 'multi_select', 'date', 'checkbox');

-- CreateEnum
CREATE TYPE "Priority" AS ENUM ('urgent', 'high', 'normal', 'low', 'none');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('admin', 'member');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "userKey" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'member',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Container" (
    "id" TEXT NOT NULL,
    "type" "ContainerType" NOT NULL,
    "name" TEXT NOT NULL,
    "parentId" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "visibility" "Visibility" NOT NULL DEFAULT 'public',
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Container_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContainerGrant" (
    "id" TEXT NOT NULL,
    "containerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mode" "GrantMode" NOT NULL,

    CONSTRAINT "ContainerGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StatusDefinition" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "StatusCategory" NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#64748b',
    "position" INTEGER NOT NULL DEFAULT 0,
    "disabled" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "StatusDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomFieldDefinition" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "FieldType" NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "options" JSONB NOT NULL DEFAULT '[]',
    "position" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "CustomFieldDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "primaryListId" TEXT NOT NULL,
    "statusId" TEXT NOT NULL,
    "title" VARCHAR(500) NOT NULL,
    "description" TEXT,
    "priority" "Priority" NOT NULL DEFAULT 'none',
    "dueDate" TIMESTAMP(3),
    "customValues" JSONB NOT NULL DEFAULT '{}',
    "position" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskAssignee" (
    "taskId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "TaskAssignee_pkey" PRIMARY KEY ("taskId","userId")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_userKey_key" ON "User"("userKey");

-- CreateIndex
CREATE INDEX "Container_parentId_position_idx" ON "Container"("parentId", "position");

-- CreateIndex
CREATE INDEX "Container_type_archivedAt_idx" ON "Container"("type", "archivedAt");

-- CreateIndex
CREATE INDEX "ContainerGrant_userId_mode_idx" ON "ContainerGrant"("userId", "mode");

-- CreateIndex
CREATE UNIQUE INDEX "ContainerGrant_containerId_userId_key" ON "ContainerGrant"("containerId", "userId");

-- CreateIndex
CREATE INDEX "StatusDefinition_ownerId_position_idx" ON "StatusDefinition"("ownerId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "StatusDefinition_ownerId_key_key" ON "StatusDefinition"("ownerId", "key");

-- CreateIndex
CREATE INDEX "CustomFieldDefinition_ownerId_position_idx" ON "CustomFieldDefinition"("ownerId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "CustomFieldDefinition_ownerId_key_key" ON "CustomFieldDefinition"("ownerId", "key");

-- CreateIndex
CREATE INDEX "Task_primaryListId_statusId_position_idx" ON "Task"("primaryListId", "statusId", "position");

-- CreateIndex
CREATE INDEX "Task_primaryListId_updatedAt_idx" ON "Task"("primaryListId", "updatedAt");

-- CreateIndex
CREATE INDEX "TaskAssignee_userId_taskId_idx" ON "TaskAssignee"("userId", "taskId");

-- AddForeignKey
ALTER TABLE "Container" ADD CONSTRAINT "Container_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Container"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContainerGrant" ADD CONSTRAINT "ContainerGrant_containerId_fkey" FOREIGN KEY ("containerId") REFERENCES "Container"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContainerGrant" ADD CONSTRAINT "ContainerGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatusDefinition" ADD CONSTRAINT "StatusDefinition_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Container"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomFieldDefinition" ADD CONSTRAINT "CustomFieldDefinition_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Container"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_primaryListId_fkey" FOREIGN KEY ("primaryListId") REFERENCES "Container"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_statusId_fkey" FOREIGN KEY ("statusId") REFERENCES "StatusDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskAssignee" ADD CONSTRAINT "TaskAssignee_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskAssignee" ADD CONSTRAINT "TaskAssignee_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
