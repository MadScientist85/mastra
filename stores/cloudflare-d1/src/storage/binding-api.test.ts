import { randomUUID } from 'crypto';
import type { D1Database } from '@cloudflare/workers-types';
import type { MastraMessageV2, WorkflowRunState } from '@mastra/core';
import type { TABLE_NAMES } from '@mastra/core/storage';
import {
  TABLE_MESSAGES,
  TABLE_THREADS,
  TABLE_WORKFLOW_SNAPSHOT,
  TABLE_EVALS,
  TABLE_TRACES,
} from '@mastra/core/storage';
import dotenv from 'dotenv';
import { Miniflare } from 'miniflare';
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi, afterEach } from 'vitest';

import {
  checkWorkflowSnapshot,
  createSampleMessage,
  createSampleThread,
  createSampleThreadWithParams,
  createSampleTrace,
  createSampleWorkflowSnapshot,
} from './test-utils';
import { D1Store } from '.';

dotenv.config();

// Increase timeout for all tests in this file
vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

describe('D1Store', () => {
  let d1Database: D1Database;
  let store: D1Store;
  const tablePrefix = 'test_';

  // Setup before all tests
  beforeAll(async () => {
    console.log('Initializing D1Store with Miniflare...');

    // Create a Miniflare instance with D1
    const mf = new Miniflare({
      modules: true,
      script: 'export default {};',
      d1Databases: { TEST_DB: ':memory:' }, // Use in-memory SQLite for tests
    });

    // Get the D1 database from Miniflare
    d1Database = await mf.getD1Database('TEST_DB');

    // Initialize the D1Store with the test database
    store = new D1Store({
      binding: d1Database,
      tablePrefix,
    });

    // Initialize tables
    await store.init();
    console.log('D1Store initialized');
  });

  // Clean up after all tests
  afterAll(async () => {
    // Clean up tables
    await store.clearTable({ tableName: TABLE_WORKFLOW_SNAPSHOT });
    await store.clearTable({ tableName: TABLE_MESSAGES });
    await store.clearTable({ tableName: TABLE_THREADS });
    await store.clearTable({ tableName: TABLE_EVALS });

    await store.close();
  });

  // Reset tables before each test
  beforeEach(async () => {
    // Clear tables for a clean state
    await store.clearTable({ tableName: TABLE_WORKFLOW_SNAPSHOT });
    await store.clearTable({ tableName: TABLE_MESSAGES });
    await store.clearTable({ tableName: TABLE_THREADS });
    await store.clearTable({ tableName: TABLE_EVALS });
  });

  describe('Table Operations', () => {
    const testTableName = 'test_table';
    const testTableName2 = 'test_table2';

    beforeEach(async () => {
      // Try to clean up the test table if it exists
      try {
        await store.clearTable({ tableName: testTableName as TABLE_NAMES });
      } catch {
        // Table might not exist yet, which is fine
      }
      try {
        await store.clearTable({ tableName: testTableName2 as TABLE_NAMES });
      } catch {
        // Table might not exist yet, which is fine
      }
    });

    it('should create a new table with schema', async () => {
      await store.createTable({
        tableName: testTableName as TABLE_NAMES,
        schema: {
          id: { type: 'text', primaryKey: true },
          title: { type: 'text' },
          data: { type: 'text', nullable: true },
          resource_id: { type: 'text' },
          created_at: { type: 'timestamp' },
        },
      });

      // Verify table exists by inserting and retrieving data
      await store.insert({
        tableName: testTableName as TABLE_NAMES,
        record: {
          id: 'test1',
          data: 'test-data',
          title: 'Test Thread',
          resource_id: 'resource-1',
        },
      });

      const result = (await store.load({ tableName: testTableName as TABLE_NAMES, keys: { id: 'test1' } })) as any;
      expect(result).toBeTruthy();
      if (result) {
        expect(result.title).toBe('Test Thread');
        expect(result.resource_id).toBe('resource-1');
      }
    });

    it('should handle multiple table creation', async () => {
      await store.createTable({
        tableName: testTableName2 as TABLE_NAMES,
        schema: {
          id: { type: 'text', primaryKey: true },
          thread_id: { type: 'text', nullable: false }, // Use nullable: false instead of required
          data: { type: 'text', nullable: true },
        },
      });

      // Verify both tables work independently
      await store.insert({
        tableName: testTableName2 as TABLE_NAMES,
        record: {
          id: 'test2',
          thread_id: 'thread-1',
          data: 'test-data-2',
        },
      });

      const result = (await store.load({
        tableName: testTableName2 as TABLE_NAMES,
        keys: { id: 'test2', thread_id: 'thread-1' },
      })) as any;
      expect(result).toBeTruthy();
      if (result) {
        expect(result.thread_id).toBe('thread-1');
        expect(result.data).toBe('test-data-2');
      }
    });

    it('should clear table data', async () => {
      await store.createTable({
        tableName: testTableName as TABLE_NAMES,
        schema: {
          id: { type: 'text', primaryKey: true },
          data: { type: 'text', nullable: true },
        },
      });

      // Insert test data
      await store.insert({
        tableName: testTableName as TABLE_NAMES,
        record: { id: 'test1', data: 'test-data' },
      });

      // Clear the table
      await store.clearTable({ tableName: testTableName as TABLE_NAMES });

      // Verify data is cleared
      const result = await store.load({
        tableName: testTableName as TABLE_NAMES,
        keys: { id: 'test1' },
      });

      expect(result).toBeNull();
    });
  });

  describe('Trace Operations', () => {
    beforeEach(async () => {
      await store.clearTable({ tableName: TABLE_TRACES });
    });

    it('should retrieve traces with filtering and pagination', async () => {
      // Insert sample traces
      const trace1 = createSampleTrace('test-trace-1', 'scope1', { env: 'prod' });
      const trace2 = createSampleTrace('test-trace-2', 'scope1', { env: 'dev' });
      const trace3 = createSampleTrace('other-trace', 'scope2', { env: 'prod' });

      await store.insert({ tableName: TABLE_TRACES, record: trace1 });
      await store.insert({ tableName: TABLE_TRACES, record: trace2 });
      await store.insert({ tableName: TABLE_TRACES, record: trace3 });

      // Test name filter
      const testTraces = await store.getTraces({ name: 'test-trace', page: 0, perPage: 10 });
      expect(testTraces).toHaveLength(2);
      expect(testTraces.map(t => t.name)).toContain('test-trace-1');
      expect(testTraces.map(t => t.name)).toContain('test-trace-2');

      // Test scope filter
      const scope1Traces = await store.getTraces({ scope: 'scope1', page: 0, perPage: 10 });
      expect(scope1Traces).toHaveLength(2);
      expect(scope1Traces.every(t => t.scope === 'scope1')).toBe(true);

      // Test attributes filter
      const prodTraces = await store.getTraces({
        attributes: { env: 'prod' },
        page: 0,
        perPage: 10,
      });
      expect(prodTraces).toHaveLength(2);
      expect(prodTraces.every(t => t.attributes.env === 'prod')).toBe(true);

      // Test pagination
      const pagedTraces = await store.getTraces({ page: 0, perPage: 2 });
      expect(pagedTraces).toHaveLength(2);

      // Test combined filters
      const combinedTraces = await store.getTraces({
        scope: 'scope1',
        attributes: { env: 'prod' },
        page: 0,
        perPage: 10,
      });
      expect(combinedTraces).toHaveLength(1);
      expect(combinedTraces[0].name).toBe('test-trace-1');

      // Verify trace object structure
      const trace = combinedTraces[0];
      expect(trace).toHaveProperty('id');
      expect(trace).toHaveProperty('parentSpanId');
      expect(trace).toHaveProperty('traceId');
      expect(trace).toHaveProperty('name');
      expect(trace).toHaveProperty('scope');
      expect(trace).toHaveProperty('kind');
      expect(trace).toHaveProperty('status');
      expect(trace).toHaveProperty('events');
      expect(trace).toHaveProperty('links');
      expect(trace).toHaveProperty('attributes');
      expect(trace).toHaveProperty('startTime');
      expect(trace).toHaveProperty('endTime');
      expect(trace).toHaveProperty('other');
      expect(trace).toHaveProperty('createdAt');

      // Verify JSON fields are parsed
      expect(typeof trace.status).toBe('object');
      expect(typeof trace.events).toBe('object');
      expect(typeof trace.links).toBe('object');
      expect(typeof trace.attributes).toBe('object');
      expect(typeof trace.other).toBe('object');
    });

    it('should handle empty results', async () => {
      const traces = await store.getTraces({ page: 0, perPage: 10 });
      expect(traces).toHaveLength(0);
    });

    it('should handle invalid JSON in fields', async () => {
      const trace = createSampleTrace('test-trace', 'scope');
      trace.status = 'invalid-json{'; // Intentionally invalid JSON

      await store.insert({ tableName: TABLE_TRACES, record: trace });
      const traces = await store.getTraces({ page: 0, perPage: 10 });

      expect(traces).toHaveLength(1);
      expect(traces[0].status).toBe('invalid-json{'); // Should return raw string when JSON parsing fails
    });
  });

  describe('Thread Operations', () => {
    it('should create and retrieve a thread', async () => {
      const thread = createSampleThread();

      // Save thread
      const savedThread = await store.saveThread({ thread });
      expect(savedThread).toEqual(thread);

      // Retrieve thread
      const retrievedThread = await store.getThreadById({ threadId: thread.id });
      expect(retrievedThread?.title).toEqual(thread.title);
      expect(retrievedThread).not.toBeNull();
      expect(retrievedThread?.id).toBe(thread.id);
      expect(retrievedThread?.title).toBe(thread.title);
      expect(retrievedThread?.metadata).toEqual(thread.metadata);
    });

    it('should return null for non-existent thread', async () => {
      const result = await store.getThreadById({ threadId: 'non-existent' });
      expect(result).toBeNull();
    });

    it('should get threads by resource ID', async () => {
      const thread1 = createSampleThread();
      const thread2 = { ...createSampleThread(), resourceId: thread1.resourceId };

      await store.saveThread({ thread: thread1 });
      await store.saveThread({ thread: thread2 });

      const threads = await store.getThreadsByResourceId({ resourceId: thread1.resourceId });
      expect(threads).toHaveLength(2);
      expect(threads.map(t => t.id)).toEqual(expect.arrayContaining([thread1.id, thread2.id]));
    });

    it('should create and retrieve a thread with the same given threadId and resourceId', async () => {
      const exampleThreadId = '1346362547862769664';
      const exampleResourceId = '532374164040974346';
      const createdAt = new Date();
      const updatedAt = new Date();
      const thread = createSampleThreadWithParams(exampleThreadId, exampleResourceId, createdAt, updatedAt);

      // Save thread
      const savedThread = await store.saveThread({ thread });
      expect(savedThread).toEqual(thread);

      // Retrieve thread
      const retrievedThread = await store.getThreadById({ threadId: thread.id });
      expect(retrievedThread?.id).toEqual(exampleThreadId);
      expect(retrievedThread?.resourceId).toEqual(exampleResourceId);
      expect(retrievedThread?.title).toEqual(thread.title);
      expect(retrievedThread?.createdAt.toISOString()).toEqual(createdAt.toISOString());
      expect(retrievedThread?.updatedAt.toISOString()).toEqual(updatedAt.toISOString());
    });

    it('should update thread title and metadata', async () => {
      const thread = createSampleThread();
      await store.saveThread({ thread });

      const updatedTitle = 'Updated Title';
      const updatedMetadata = { newKey: 'newValue' };
      const updatedThread = await store.updateThread({
        id: thread.id,
        title: updatedTitle,
        metadata: updatedMetadata,
      });

      expect(updatedThread.title).toBe(updatedTitle);
      expect(updatedThread.metadata).toEqual({
        ...thread.metadata,
        ...updatedMetadata,
      });

      // Verify persistence with retry
      const retrieved = await store.getThreadById({ threadId: thread.id });
      expect(retrieved?.title).toBe(updatedTitle);
      expect(retrieved?.metadata).toEqual(expect.objectContaining(updatedMetadata));
    });

    it('should delete thread and its messages', async () => {
      const thread = createSampleThread();
      await store.saveThread({ thread });

      // Add some messages
      const messages = [createSampleMessage(thread.id), createSampleMessage(thread.id)];
      await store.saveMessages({ messages, format: 'v2' });

      await store.deleteThread({ threadId: thread.id });

      // Verify thread deletion
      const retrievedThread = await store.getThreadById({ threadId: thread.id });
      expect(retrievedThread).toBeNull();

      // Verify thread is gone
      const threads = await store.getThreadsByResourceId({ resourceId: thread.resourceId });
      expect(threads).toHaveLength(0);

      // Verify messages were also deleted
      const retrievedMessages = await store.getMessages({ threadId: thread.id, format: 'v2' });
      expect(retrievedMessages).toHaveLength(0);
    });
  });

  describe('Message Operations', () => {
    it('should handle empty message array', async () => {
      const result = await store.saveMessages({ messages: [] });
      expect(result).toEqual([]);
    });
    it('should save and retrieve messages', async () => {
      const thread = createSampleThread();
      await store.saveThread({ thread });

      const messages = [createSampleMessage(thread.id), createSampleMessage(thread.id)];

      // Save messages
      const savedMessages = await store.saveMessages({ messages, format: 'v2' });
      expect(savedMessages).toEqual(messages);

      // Retrieve messages
      const retrievedMessages = await store.getMessages({ threadId: thread.id, format: 'v2' });
      const checkMessages = messages.map(m => {
        const { resourceId, ...rest } = m;
        return rest;
      });
      expect(retrievedMessages).toEqual(expect.arrayContaining(checkMessages));
    });

    it('should handle empty message array', async () => {
      const result = await store.saveMessages({ messages: [] });
      expect(result).toEqual([]);
    });

    it('should maintain message order', async () => {
      const thread = createSampleThread();
      await store.saveThread({ thread });

      const messages = [
        createSampleMessage(thread.id, [{ type: 'text' as const, text: 'First' }]),
        createSampleMessage(thread.id, [{ type: 'text' as const, text: 'Second' }]),
        createSampleMessage(thread.id, [{ type: 'text' as const, text: 'Third' }]),
      ] satisfies MastraMessageV2[];

      await store.saveMessages({ messages, format: 'v2' });

      const retrievedMessages = await store.getMessages({ threadId: thread.id, format: 'v2' });
      expect(retrievedMessages).toHaveLength(3);

      // Verify order is maintained
      retrievedMessages.forEach((msg, idx) => {
        expect(msg.content).toEqual(messages[idx].content);
      });
    });

    it('should rollback on error during message save', async () => {
      const thread = createSampleThread();
      await store.saveThread({ thread });

      const messages = [
        createSampleMessage(thread.id),
        { ...createSampleMessage(thread.id), id: null }, // This will cause an error
      ] as any as MastraMessageV2[];

      await expect(store.saveMessages({ messages, format: 'v2' })).rejects.toThrow();

      // Verify no messages were saved
      const savedMessages = await store.getMessages({ threadId: thread.id, format: 'v2' });
      expect(savedMessages).toHaveLength(0);
    });
  });

  describe('Workflow Operations', () => {
    beforeAll(async () => {
      // Create workflow_snapshot table
      await store.createTable({
        tableName: TABLE_WORKFLOW_SNAPSHOT,
        schema: {
          workflow_name: { type: 'text', nullable: false },
          run_id: { type: 'text', nullable: false },
          snapshot: { type: 'text', nullable: false },
          created_at: { type: 'timestamp', nullable: false },
          updated_at: { type: 'timestamp', nullable: false },
        },
      });
    });
    it('should save and retrieve workflow snapshots', async () => {
      const thread = createSampleThread();
      const { snapshot, runId } = createSampleWorkflowSnapshot(thread.id, 'success');

      await store.persistWorkflowSnapshot({
        workflowName: 'test-workflow',
        runId,
        snapshot,
      });
      await new Promise(resolve => setTimeout(resolve, 5000));

      const retrieved = await store.loadWorkflowSnapshot({
        workflowName: 'test-workflow',
        runId,
      });
      expect(retrieved).toEqual(snapshot);
    });

    it('should handle non-existent workflow snapshots', async () => {
      const result = await store.loadWorkflowSnapshot({
        workflowName: 'test-workflow',
        runId: 'non-existent',
      });
      expect(result).toBeNull();
    });

    it('should update workflow snapshot status', async () => {
      const thread = createSampleThread();
      const { snapshot, runId } = createSampleWorkflowSnapshot(thread.id, 'success');

      await store.persistWorkflowSnapshot({
        workflowName: 'test-workflow',
        runId,
        snapshot,
      });

      const updatedSnapshot = {
        ...snapshot,
        value: { [runId]: 'completed' },
        timestamp: Date.now(),
      };

      await store.persistWorkflowSnapshot({
        workflowName: 'test-workflow',
        runId,
        snapshot: updatedSnapshot,
      });

      const retrieved = await store.loadWorkflowSnapshot({
        workflowName: 'test-workflow',
        runId,
      });
      expect(retrieved?.value[runId]).toBe('completed');
      expect(retrieved?.timestamp).toBeGreaterThan(snapshot.timestamp);
    });
  });

  describe('Date Handling', () => {
    it('should handle Date objects in thread operations', async () => {
      const now = new Date();
      const thread = {
        id: 'thread-date-1',
        resourceId: 'resource-1',
        title: 'Test Thread',
        createdAt: now,
        updatedAt: now,
        metadata: {},
      };

      await store.saveThread({ thread });
      const retrievedThread = await store.getThreadById({ threadId: thread.id });
      expect(retrievedThread?.createdAt).toBeInstanceOf(Date);
      expect(retrievedThread?.updatedAt).toBeInstanceOf(Date);
      expect(retrievedThread?.createdAt.toISOString()).toBe(now.toISOString());
      expect(retrievedThread?.updatedAt.toISOString()).toBe(now.toISOString());
    });

    it('should handle ISO string dates in thread operations', async () => {
      const now = new Date();
      const thread = {
        id: 'thread-date-2',
        resourceId: 'resource-1',
        title: 'Test Thread',
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        metadata: {},
      };

      await store.saveThread({ thread: thread as any });
      const retrievedThread = await store.getThreadById({ threadId: thread.id });
      expect(retrievedThread?.createdAt).toBeInstanceOf(Date);
      expect(retrievedThread?.updatedAt).toBeInstanceOf(Date);
      expect(retrievedThread?.createdAt.toISOString()).toBe(now.toISOString());
      expect(retrievedThread?.updatedAt.toISOString()).toBe(now.toISOString());
    });
  });

  describe('Message Ordering', () => {
    it('should handle duplicate timestamps gracefully', async () => {
      const thread = createSampleThread();
      await store.saveThread({ thread });

      // Create messages with identical timestamps
      const timestamp = new Date();
      const messages = Array.from({ length: 3 }, () => ({
        ...createSampleMessage(thread.id),
        createdAt: timestamp,
      }));

      await store.saveMessages({ messages, format: 'v2' });

      // Verify order is maintained based on insertion order
      const order = await store.getMessages({ threadId: thread.id, format: 'v2' });
      const orderIds = order.map(m => m.id);
      const messageIds = messages.map(m => m.id);

      // Order should match insertion order
      expect(orderIds).toEqual(messageIds);
    });

    it('should preserve write order when messages are saved concurrently', async () => {
      const thread = createSampleThread();
      await store.saveThread({ thread });

      // Create messages with different timestamps
      const now = Date.now();
      const messages = Array.from({ length: 3 }, (_, i) => ({
        ...createSampleMessage(thread.id),
        createdAt: new Date(now - (2 - i) * 1000), // timestamps: oldest -> newest
      }));

      // Save messages in reverse order to verify write order is preserved
      const reversedMessages = [...messages].reverse(); // newest -> oldest
      await Promise.all(reversedMessages.map(msg => store.saveMessages({ messages: [msg], format: 'v2' })));

      // Verify messages are saved and maintain write order (not timestamp order)
      const order = await store.getMessages({ threadId: thread.id, format: 'v2' });
      const orderIds = order.map(m => m.id);
      const messageIds = messages.map(m => m.id);

      // Order should match insertion order
      expect(orderIds).toEqual(messageIds);
    });

    it('should maintain message order using sorted sets', async () => {
      const thread = createSampleThread();
      await store.saveThread({ thread });

      // Create messages with explicit timestamps to test chronological ordering
      const baseTime = new Date('2025-03-14T23:30:20.930Z').getTime();
      const messages = [
        {
          ...createSampleMessage(thread.id, [{ type: 'text', text: 'First' }]),
          createdAt: new Date(baseTime),
        },
        {
          ...createSampleMessage(thread.id, [{ type: 'text', text: 'Second' }]),
          createdAt: new Date(baseTime + 1000),
        },
        {
          ...createSampleMessage(thread.id, [{ type: 'text', text: 'Third' }]),
          createdAt: new Date(baseTime + 2000),
        },
      ] as MastraMessageV2[];

      await store.saveMessages({ messages, format: 'v2' });

      await new Promise(resolve => setTimeout(resolve, 5000));

      // Get messages and verify order
      const order = await store.getMessages({ threadId: thread.id, format: 'v2' });
      expect(order.length).toBe(3);
    });
  });

  describe('Workflow Snapshots', () => {
    beforeEach(async () => {
      // Clear workflow snapshots before each test
      await store.clearTable({ tableName: TABLE_WORKFLOW_SNAPSHOT });
    });

    it('should persist and load workflow snapshots', async () => {
      const thread = createSampleThread();
      const { snapshot, runId } = createSampleWorkflowSnapshot(thread.id, 'running');

      await store.persistWorkflowSnapshot({
        workflowName: 'test-workflow',
        runId,
        snapshot,
      });
      await new Promise(resolve => setTimeout(resolve, 5000));

      const retrieved = await store.loadWorkflowSnapshot({
        workflowName: 'test-workflow',
        runId,
      });

      expect(retrieved).toEqual(snapshot);
    });

    it('should handle non-existent workflow snapshots', async () => {
      const retrieved = await store.loadWorkflowSnapshot({
        workflowName: 'non-existent',
        runId: 'non-existent',
      });

      expect(retrieved).toBeNull();
    });

    it('should update existing workflow snapshot', async () => {
      const thread = createSampleThread();
      const { snapshot, runId } = createSampleWorkflowSnapshot(thread.id, 'running');

      await store.persistWorkflowSnapshot({
        workflowName: 'test-workflow',
        runId,
        snapshot,
      });

      const updatedSnapshot = {
        ...snapshot,
        value: { [runId]: 'completed' },
        timestamp: Date.now(),
      };

      await store.persistWorkflowSnapshot({
        workflowName: 'test-workflow',
        runId,
        snapshot: updatedSnapshot,
      });

      const loadedSnapshot = await store.loadWorkflowSnapshot({
        workflowName: 'test-workflow',
        runId,
      });

      expect(loadedSnapshot).toEqual(updatedSnapshot);
    });

    it('should handle complex workflow state', async () => {
      const runId = `run-${randomUUID()}`;
      const workflowName = 'complex-workflow';

      const complexSnapshot = {
        runId,
        value: { currentState: 'running' },
        timestamp: Date.now(),
        context: {
          'step-1': {
            status: 'success',
            output: {
              nestedData: {
                array: [1, 2, 3],
                object: { key: 'value' },
                date: new Date().toISOString(),
              },
            },
          },
          'step-2': {
            status: 'suspended',
            dependencies: ['step-3', 'step-4'],
          },
          input: {
            type: 'scheduled',
            metadata: {
              schedule: '0 0 * * *',
              timezone: 'UTC',
            },
          },
        },
        activePaths: [],
        suspendedPaths: {},
      } as unknown as WorkflowRunState;

      await store.persistWorkflowSnapshot({
        workflowName,
        runId,
        snapshot: complexSnapshot,
      });

      const loadedSnapshot = await store.loadWorkflowSnapshot({
        workflowName,
        runId,
      });

      expect(loadedSnapshot).toEqual(complexSnapshot);
    });
  });

  describe('getWorkflowRuns', () => {
    beforeEach(async () => {
      await store.clearTable({ tableName: TABLE_WORKFLOW_SNAPSHOT });
    });
    it('returns empty array when no workflows exist', async () => {
      const { runs, total } = await store.getWorkflowRuns();
      expect(runs).toEqual([]);
      expect(total).toBe(0);
    });

    it('returns all workflows by default', async () => {
      const workflowName1 = 'default_test_1';
      const workflowName2 = 'default_test_2';
      const thread = createSampleThread();

      const {
        snapshot: workflow1,
        runId: runId1,
        stepId: stepId1,
      } = createSampleWorkflowSnapshot(thread.id, 'success');
      const { snapshot: workflow2, runId: runId2, stepId: stepId2 } = createSampleWorkflowSnapshot(thread.id, 'failed');

      await store.persistWorkflowSnapshot({ workflowName: workflowName1, runId: runId1, snapshot: workflow1 });
      await new Promise(resolve => setTimeout(resolve, 10)); // Small delay to ensure different timestamps
      await store.persistWorkflowSnapshot({ workflowName: workflowName2, runId: runId2, snapshot: workflow2 });

      const { runs, total } = await store.getWorkflowRuns();
      expect(runs).toHaveLength(2);
      expect(total).toBe(2);
      expect(runs[0]!.workflowName).toBe(workflowName2); // Most recent first
      expect(runs[1]!.workflowName).toBe(workflowName1);
      const firstSnapshot = runs[0]!.snapshot;
      const secondSnapshot = runs[1]!.snapshot;
      checkWorkflowSnapshot(firstSnapshot, stepId2, 'failed');
      checkWorkflowSnapshot(secondSnapshot, stepId1, 'success');
    });

    it('filters by workflow name', async () => {
      const workflowName1 = 'filter_test_1';
      const workflowName2 = 'filter_test_2';
      const thread = createSampleThread();

      const {
        snapshot: workflow1,
        runId: runId1,
        stepId: stepId1,
      } = createSampleWorkflowSnapshot(thread.id, 'success');
      const { snapshot: workflow2, runId: runId2 } = createSampleWorkflowSnapshot(thread.id, 'failed');

      await store.persistWorkflowSnapshot({ workflowName: workflowName1, runId: runId1, snapshot: workflow1 });
      await new Promise(resolve => setTimeout(resolve, 10)); // Small delay to ensure different timestamps
      await store.persistWorkflowSnapshot({ workflowName: workflowName2, runId: runId2, snapshot: workflow2 });

      const { runs, total } = await store.getWorkflowRuns({ workflowName: workflowName1 });
      expect(runs).toHaveLength(1);
      expect(total).toBe(1);
      expect(runs[0]!.workflowName).toBe(workflowName1);
      const snapshot = runs[0]!.snapshot;
      checkWorkflowSnapshot(snapshot, stepId1, 'success');
    });

    it('filters by date range', async () => {
      const now = new Date();
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
      const workflowName1 = 'date_test_1';
      const workflowName2 = 'date_test_2';
      const workflowName3 = 'date_test_3';
      const thread = createSampleThread();

      const { snapshot: workflow1, runId: runId1 } = createSampleWorkflowSnapshot(thread.id, 'success');
      const { snapshot: workflow2, runId: runId2, stepId: stepId2 } = createSampleWorkflowSnapshot(thread.id, 'failed');
      const {
        snapshot: workflow3,
        runId: runId3,
        stepId: stepId3,
      } = createSampleWorkflowSnapshot(thread.id, 'suspended');

      await store.insert({
        tableName: TABLE_WORKFLOW_SNAPSHOT,
        record: {
          workflow_name: workflowName1,
          run_id: runId1,
          snapshot: workflow1,
          createdAt: twoDaysAgo,
          updatedAt: twoDaysAgo,
        },
      });
      await store.insert({
        tableName: TABLE_WORKFLOW_SNAPSHOT,
        record: {
          workflow_name: workflowName2,
          run_id: runId2,
          snapshot: workflow2,
          createdAt: yesterday,
          updatedAt: yesterday,
        },
      });
      await store.insert({
        tableName: TABLE_WORKFLOW_SNAPSHOT,
        record: {
          workflow_name: workflowName3,
          run_id: runId3,
          snapshot: workflow3,
          createdAt: now,
          updatedAt: now,
        },
      });

      const { runs } = await store.getWorkflowRuns({
        fromDate: yesterday,
        toDate: now,
      });

      expect(runs).toHaveLength(2);
      expect(runs[0]!.workflowName).toBe(workflowName3);
      expect(runs[1]!.workflowName).toBe(workflowName2);
      const firstSnapshot = runs[0]!.snapshot;
      const secondSnapshot = runs[1]!.snapshot;
      checkWorkflowSnapshot(firstSnapshot, stepId3, 'suspended');
      checkWorkflowSnapshot(secondSnapshot, stepId2, 'failed');
    });

    it('handles pagination', async () => {
      const workflowName1 = 'page_test_1';
      const workflowName2 = 'page_test_2';
      const workflowName3 = 'page_test_3';
      const thread = createSampleThread();

      const {
        snapshot: workflow1,
        runId: runId1,
        stepId: stepId1,
      } = createSampleWorkflowSnapshot(thread.id, 'success');
      const { snapshot: workflow2, runId: runId2, stepId: stepId2 } = createSampleWorkflowSnapshot(thread.id, 'failed');
      const {
        snapshot: workflow3,
        runId: runId3,
        stepId: stepId3,
      } = createSampleWorkflowSnapshot(thread.id, 'suspended');

      await store.persistWorkflowSnapshot({ workflowName: workflowName1, runId: runId1, snapshot: workflow1 });
      await new Promise(resolve => setTimeout(resolve, 10)); // Small delay to ensure different timestamps
      await store.persistWorkflowSnapshot({ workflowName: workflowName2, runId: runId2, snapshot: workflow2 });
      await new Promise(resolve => setTimeout(resolve, 10)); // Small delay to ensure different timestamps
      await store.persistWorkflowSnapshot({ workflowName: workflowName3, runId: runId3, snapshot: workflow3 });

      // Get first page
      const page1 = await store.getWorkflowRuns({ limit: 2, offset: 0 });
      expect(page1.runs).toHaveLength(2);
      expect(page1.total).toBe(3); // Total count of all records
      expect(page1.runs[0]!.workflowName).toBe(workflowName3);
      expect(page1.runs[1]!.workflowName).toBe(workflowName2);
      const firstSnapshot = page1.runs[0]!.snapshot;
      const secondSnapshot = page1.runs[1]!.snapshot;
      checkWorkflowSnapshot(firstSnapshot, stepId3, 'suspended');
      checkWorkflowSnapshot(secondSnapshot, stepId2, 'failed');

      // Get second page
      const page2 = await store.getWorkflowRuns({ limit: 2, offset: 2 });
      expect(page2.runs).toHaveLength(1);
      expect(page2.total).toBe(3);
      expect(page2.runs[0]!.workflowName).toBe(workflowName1);
      const snapshot = page2.runs[0]!.snapshot;
      checkWorkflowSnapshot(snapshot, stepId1, 'success');
    });
  });

  describe('getWorkflowRunById', () => {
    const workflowName = 'workflow-id-test';
    let runId: string;
    let stepId: string;

    beforeEach(async () => {
      // Insert a workflow run for positive test
      const thread = createSampleThread();
      const sample = createSampleWorkflowSnapshot(thread.id, 'success');
      runId = sample.runId;
      stepId = sample.stepId;
      await store.insert({
        tableName: TABLE_WORKFLOW_SNAPSHOT,
        record: {
          workflow_name: workflowName,
          run_id: runId,
          resourceId: 'resource-abc',
          snapshot: sample.snapshot,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });
    });

    it('should retrieve a workflow run by ID', async () => {
      const found = await store.getWorkflowRunById({
        runId,
        workflowName,
      });
      expect(found).not.toBeNull();
      expect(found?.runId).toBe(runId);
      checkWorkflowSnapshot(found?.snapshot!, stepId, 'success');
    });

    it('should return null for non-existent workflow run ID', async () => {
      const notFound = await store.getWorkflowRunById({
        runId: 'non-existent-id',
        workflowName,
      });
      expect(notFound).toBeNull();
    });
  });
  describe('getWorkflowRuns with resourceId', () => {
    const workflowName = 'workflow-id-test';
    let resourceId: string;
    let runIds: string[] = [];

    beforeEach(async () => {
      const thread = createSampleThread();
      // Insert multiple workflow runs for the same resourceId
      resourceId = 'resource-shared';
      for (const status of ['success', 'failed']) {
        const sample = createSampleWorkflowSnapshot(thread.id, status);
        runIds.push(sample.runId);
        await store.insert({
          tableName: TABLE_WORKFLOW_SNAPSHOT,
          record: {
            workflow_name: workflowName,
            run_id: sample.runId,
            resourceId,
            snapshot: sample.snapshot,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        });
      }
      // Insert a run with a different resourceId
      const other = createSampleWorkflowSnapshot(thread.id, 'waiting');
      await store.insert({
        tableName: TABLE_WORKFLOW_SNAPSHOT,
        record: {
          workflow_name: workflowName,
          run_id: other.runId,
          resourceId: 'resource-other',
          snapshot: other.snapshot,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });
    });

    it('should retrieve all workflow runs by resourceId', async () => {
      const { runs } = await store.getWorkflowRuns({
        resourceId,
        workflowName,
      });
      expect(Array.isArray(runs)).toBe(true);
      expect(runs.length).toBeGreaterThanOrEqual(2);
      for (const run of runs) {
        expect(run.resourceId).toBe(resourceId);
      }
    });

    it('should return an empty array if no workflow runs match resourceId', async () => {
      const { runs } = await store.getWorkflowRuns({
        resourceId: 'non-existent-resource',
        workflowName,
      });
      expect(Array.isArray(runs)).toBe(true);
      expect(runs.length).toBe(0);
    });
  });

  describe('hasColumn', () => {
    const tempTable = 'temp_test_table';

    beforeEach(async () => {
      // Always try to drop the table before each test, ignore errors if it doesn't exist
      try {
        await store['executeQuery']({ sql: `DROP TABLE IF EXISTS ${tempTable}` });
      } catch {
        /* ignore */
      }
    });

    it('returns true if the column exists', async () => {
      await store['executeQuery']({ sql: `CREATE TABLE ${tempTable} (id SERIAL PRIMARY KEY, resourceId TEXT)` });
      expect(await store['hasColumn'](tempTable, 'resourceId')).toBe(true);
    });

    it('returns false if the column does not exist', async () => {
      await store['executeQuery']({ sql: `CREATE TABLE ${tempTable} (id SERIAL PRIMARY KEY)` });
      expect(await store['hasColumn'](tempTable, 'resourceId')).toBe(false);
    });

    afterEach(async () => {
      // Always try to drop the table after each test, ignore errors if it doesn't exist
      try {
        await store['executeQuery']({ sql: `DROP TABLE IF EXISTS ${tempTable}` });
      } catch {
        /* ignore */
      }
    });
  });

  describe('Data Validation', () => {
    it('should handle missing optional fields', async () => {
      const thread = {
        ...createSampleThread(),
        metadata: undefined, // Optional field
      };
      await store.saveThread({ thread });

      // Should be able to retrieve thread
      const threads = await store.getThreadsByResourceId({ resourceId: thread.resourceId });
      expect(threads).toHaveLength(1);
      expect(threads[0].id).toBe(thread.id);
      expect(threads[0].metadata).toStrictEqual({});
    });

    it('should sanitize and handle special characters', async () => {
      const thread = createSampleThread();
      const message = createSampleMessage(thread.id, [{ type: 'text' as const, text: '特殊字符 !@#$%^&*()' }]);

      await store.saveThread({ thread });
      await store.saveMessages({ messages: [message], format: 'v2' });

      // Should retrieve correctly
      const messages = await store.getMessages({ threadId: thread.id, format: 'v2' });
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toEqual(message.content);
    });
  });

  describe('Concurrent Operations', () => {
    it('should handle concurrent message updates concurrently', async () => {
      const thread = createSampleThread();
      await store.saveThread({ thread });

      // Create messages with sequential timestamps (but write order will be preserved)
      const now = Date.now();
      const messages = Array.from({ length: 5 }, (_, i) => ({
        ...createSampleMessage(thread.id),
        createdAt: new Date(now + i * 1000),
      }));

      // Save messages in parallel - write order should be preserved
      await Promise.all(messages.map(msg => store.saveMessages({ messages: [msg], format: 'v2' })));

      // Order should reflect write order, not timestamp order
      const order = await store.getMessages({ threadId: thread.id, format: 'v2' });

      // Verify messages exist in write order
      const orderIds = order.map(m => m.id);
      const messageIds = messages.map(m => m.id);
      expect(orderIds).toEqual(messageIds);

      // Verify all messages were saved
      expect(order.length).toBe(messages.length);
      expect(new Set(orderIds)).toEqual(new Set(messageIds));
    });
  });

  describe('Resource Management', () => {
    it('should clean up orphaned messages when thread is deleted', async () => {
      const thread = createSampleThread();
      const messages = Array.from({ length: 3 }, () => createSampleMessage(thread.id));

      await store.saveThread({ thread });
      await store.saveMessages({ messages, format: 'v2' });

      // Verify messages exist
      const initialOrder = await store.getMessages({ threadId: thread.id, format: 'v2' });
      expect(initialOrder).toHaveLength(messages.length);

      // Delete thread
      await store.deleteThread({ threadId: thread.id });

      await new Promise(resolve => setTimeout(resolve, 5000));

      // Verify messages are cleaned up
      const finalOrder = await store.getMessages({ threadId: thread.id, format: 'v2' });
      expect(finalOrder).toHaveLength(0);

      // Verify thread is gone
      const threads = await store.getThreadsByResourceId({ resourceId: thread.resourceId });
      expect(threads).toHaveLength(0);
    });
  });

  describe('Large Data Handling', () => {
    it('should handle large metadata objects', async () => {
      const thread = createSampleThread();
      const largeMetadata = {
        ...thread.metadata,
        largeArray: Array.from({ length: 1000 }, (_, i) => ({
          index: i,
          data: 'test'.repeat(100),
        })),
      };

      const threadWithLargeMetadata = {
        ...thread,
        metadata: largeMetadata,
      };

      await store.saveThread({ thread: threadWithLargeMetadata });
      const retrieved = await store.getThreadById({ threadId: thread.id });

      expect(retrieved?.metadata).toEqual(largeMetadata);
    });

    it('should handle concurrent thread operations', async () => {
      const threads = Array.from({ length: 10 }, () => createSampleThread());

      // Save all threads concurrently
      await Promise.all(threads.map(thread => store.saveThread({ thread })));

      // Retrieve all threads concurrently
      const retrievedThreads = await Promise.all(threads.map(thread => store.getThreadById({ threadId: thread.id })));

      expect(retrievedThreads.length).toBe(threads.length);
      retrievedThreads.forEach((retrieved, i) => {
        expect(retrieved?.id).toBe(threads[i].id);
      });
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid message data', async () => {
      const thread = createSampleThread();
      await store.saveThread({ thread });

      // Try to save invalid message
      const invalidMessage = {
        ...createSampleMessage(thread.id),
        content: undefined,
      };

      await expect(
        store.saveMessages({
          messages: [invalidMessage as any],
        }),
      ).rejects.toThrow();
    });

    it('should handle missing thread gracefully', async () => {
      const message = createSampleMessage('non-existent-thread');
      await expect(
        store.saveMessages({
          messages: [message],
          format: 'v2',
        }),
      ).rejects.toThrow();
    });

    it('should handle malformed data gracefully', async () => {
      const thread = createSampleThread();
      await store.saveThread({ thread });

      // Test with various malformed data
      const malformedMessage = createSampleMessage(thread.id, [
        { type: 'text' as const, text: ''.padStart(1024 * 1024, 'x') },
      ]);

      await store.saveMessages({ messages: [malformedMessage], format: 'v2' });

      // Should still be able to retrieve and handle the message
      const messages = await store.getMessages({ threadId: thread.id, format: 'v2' });
      expect(messages).toHaveLength(1);
      expect(messages[0].id).toBe(malformedMessage.id);
    });

    it('should handle large metadata objects', async () => {
      const thread = createSampleThread();
      const largeMetadata = {
        ...thread.metadata,
        largeArray: Array.from({ length: 1000 }, (_, i) => ({ index: i, data: 'test'.repeat(100) })),
      };

      const threadWithLargeMetadata = {
        ...thread,
        metadata: largeMetadata,
      };

      await store.saveThread({ thread: threadWithLargeMetadata });
      const retrieved = await store.getThreadById({ threadId: thread.id });

      expect(retrieved?.metadata).toEqual(largeMetadata);
    });

    it('should handle special characters in thread titles', async () => {
      const thread = {
        ...createSampleThread(),
        title: 'Special \'quotes\' and "double quotes" and emoji 🎉',
      };

      await store.saveThread({ thread });
      const retrieved = await store.getThreadById({ threadId: thread.id });

      expect(retrieved?.title).toBe(thread.title);
    });
  });
});
