import performanceNow from 'performance-now';
import { Stats } from 'fast-stats';

import { Benchmark, BenchmarkMetadata, BenchmarkConstructor } from './Benchmark';
import { Client, ClientMetadata, ClientConstructor } from './Client';
import { Event } from './Event';
import { Example, RawExample } from './Example';

const { Phase, Subject, Type } = Event;

export interface Configuration {
  // Run the benchmark and verify() results this many times to ferret out bugs.
  verifyPasses: number;
  // Run the benchmark this many times to warm up the VM's cache.
  warmups: number;
  // Minimum number of samples (before we start checking the margin of error).
  minSamples: number;
  // Maximum duration of an entire benchmark run.
  maxDurationMs: number;
  // Desired percent relative margin of error
  targetRelativeMarginOfError: number;
}

interface Context {
  reporter: Reporter;
  config: Configuration;
  rawExample: RawExample;
  eventCommon: Event.SuiteValues;
  canceled?: true;
  failure?: Event.Failure;
}

export interface Reporter {
  (event: Event): void;
}

export interface SuitePromise extends Promise<void> {
  cancel(): void;
}

const DEFAULT_CONFIG: Configuration = {
  verifyPasses: 2,
  warmups: 10,
  minSamples: 25,
  maxDurationMs: 15 /* seconds */ * 1e3,
  targetRelativeMarginOfError: 5.0,
};

const customConfig: Configuration = {
  verifyPasses: 1,
  warmups: 0,
  minSamples: 2,
  maxDurationMs: 1 /* seconds */ * 1e3,
  targetRelativeMarginOfError: 15.0,
};

export function runSuite(
  reporter: Reporter,
  benchmarkClasses: BenchmarkConstructor[],
  clientClasses: ClientConstructor[],
  rawExample: RawExample,
  config: Configuration = customConfig,
): SuitePromise {
  const context: Context = {
    reporter,
    config,
    rawExample,
    eventCommon: {
      clients: clientClasses.map(c => c.metadata),
      benchmarks: benchmarkClasses.map(b => b.metadata),
      example: rawExample,
      canceled: false,
    },
  };

  const innerPromise = _runSuite(context, benchmarkClasses, clientClasses);

  const promise: SuitePromise = innerPromise.then(() => {
    return context.canceled;
  }) as any;
  promise.cancel = function cancel() {
    context.canceled = true;
    context.eventCommon.canceled = true;
  };

  return promise;
}

export async function _runSuite(
  context: Context,
  benchmarkClasses: BenchmarkConstructor[],
  clientClasses: ClientConstructor[],
) {
  const { reporter, rawExample } = context;
  reporter({ ...context.eventCommon, subject: Subject.SUITE, type: Type.START });

  for (const BenchmarkClass of benchmarkClasses) {
    if (context.canceled) break;
    reporter({
      ...context.eventCommon,
      subject: Subject.BENCHMARK,
      type: Type.START,
      benchmark: BenchmarkClass.metadata,
    });

    for (const ClientClass of clientClasses) {
      if (context.canceled) break;
      await runClientBenchmark(context, BenchmarkClass, ClientClass);
    }

    reporter({
      ...context.eventCommon,
      subject: Subject.BENCHMARK,
      type: Type.END,
      benchmark: BenchmarkClass.metadata,
    });
  }

  reporter({ ...context.eventCommon, subject: Subject.SUITE, type: Type.END });
}

async function runClientBenchmark(
  context: Context,
  BenchmarkClass: BenchmarkConstructor,
  ClientClass: ClientConstructor,
) {
  const { reporter, rawExample, config } = context;

  const eventCommon = {
    ...context.eventCommon,
    benchmark: BenchmarkClass.metadata,
    client: ClientClass.metadata,
  };
  reporter({
    ...eventCommon,
    subject: Subject.CLIENT_BENCHMARK,
    type: Type.START,
  });

  // Establish a memory baseline for the client
  let heapUsedBase, heapTotalBase;
  if (global.gc) {
    const { memoryUsage } = require('process');
    global.gc();
    let { heapUsed, heapTotal } = memoryUsage();
    heapUsedBase = heapUsed;
    heapTotalBase = heapTotal;
  }

  const client: Client = new ClientClass();

  const { title, schema, partials } = rawExample;

  // Preprocess & Verify

  reporter({
    ...eventCommon,
    subject: Subject.CLIENT_BENCHMARK_PHASE,
    phase: Phase.VERIFY,
    type: Type.START,
  });
  const verifyStart = performanceNow();

  let example: Example;
  try {
    const rootExample = client.transformRawExample(rawExample);
    example = {
      ...rootExample,
      title,
      partials: partials.map(p => client.transformRawExample({ ...p, schema } as any)),
    };
  } catch (error) {
    context.failure = { error, phase: Phase.VERIFY };
  }

  for (let i = 0; i < config.verifyPasses; i++) {
    if (context.canceled || context.failure) break;
    await runSingleBenchmarkPass(context, BenchmarkClass, ClientClass, example, Phase.VERIFY, {
      verify: true,
    });
  }
  reporter({
    ...eventCommon,
    subject: Subject.CLIENT_BENCHMARK_PHASE,
    phase: Phase.VERIFY,
    type: Type.END,
    duration: performanceNow() - verifyStart,
    failure: context.failure,
  });

  // Brief pause to give the UI (and maybe GC) a chance to catch up.
  await new Promise(resolve => setTimeout(resolve, 50));

  // Warmup

  if (!context.canceled && !context.failure) {
    reporter({
      ...eventCommon,
      subject: Subject.CLIENT_BENCHMARK_PHASE,
      phase: Phase.WARMUP,
      type: Type.START,
    });
    const warmupStart = performanceNow();
    for (let i = 0; i < config.warmups; i++) {
      if (context.canceled || context.failure) break;
      await runSingleBenchmarkPass(context, BenchmarkClass, ClientClass, example, Phase.WARMUP);
    }
    reporter({
      ...eventCommon,
      subject: Subject.CLIENT_BENCHMARK_PHASE,
      phase: Phase.WARMUP,
      type: Type.END,
      duration: performanceNow() - warmupStart,
      failure: context.failure,
    });
  }

  // Brief pause to give the UI (and maybe GC) a chance to catch up.
  await new Promise(resolve => setTimeout(resolve, 50));

  // Iterations

  const stats = new Stats();
  const heapUsedStats = new Stats();
  const heapTotalStats = new Stats();
  const runStart = performanceNow();
  if (!context.canceled && !context.failure) {
    while (true) {
      if (context.canceled || context.failure) break;

      reporter({
        ...eventCommon,
        subject: Subject.CLIENT_BENCHMARK_PHASE,
        phase: Phase.ITERATION,
        type: Type.START,
      });

      const { duration, memoryUsage } = await runSingleBenchmarkPass(
        context,
        BenchmarkClass,
        ClientClass,
        example,
        Phase.ITERATION,
      );
      if (typeof duration !== 'undefined') {
        stats.push(duration);
      }
      if (typeof memoryUsage !== 'undefined') {
        heapUsedStats.push(memoryUsage.heapUsed);
        heapTotalStats.push(memoryUsage.heapTotal);
      }

      reporter({
        ...eventCommon,
        subject: Subject.CLIENT_BENCHMARK_PHASE,
        phase: Phase.ITERATION,
        type: Type.END,
        duration,
        stats: statsSummary(stats, heapUsedStats, heapTotalStats, heapUsedBase, heapTotalBase),
        failure: context.failure,
      });

      if (isFinalIteration(config, runStart, stats)) break;
    }
  }

  // Brief pause to give the UI (and maybe GC) a chance to catch up.
  await new Promise(resolve => setTimeout(resolve, 10));

  // Remove outliers.
  const finalStats = statsSummary(
    stats.iqr(),
    heapUsedStats.iqr(),
    heapTotalStats.iqr(),
    heapUsedBase,
    heapTotalBase,
  );

  reporter({
    ...eventCommon,
    subject: Subject.CLIENT_BENCHMARK,
    type: Type.END,
    stats: finalStats,
    failure: context.failure,
  });

  // And we're done with the failure
  context.failure = undefined;

  // save findings into json file, to chart it later
  if (stats) saveData(client.constructor.name, stats.amean());

  return finalStats;
}

function isFinalIteration(config: Configuration, runStart: number, stats: Stats) {
  if (stats.length < config.minSamples) return false;
  if (performanceNow() - runStart > config.maxDurationMs) return true;
  if (percentRelativeMarginOfError(stats) <= config.targetRelativeMarginOfError) return true;
  return false;
}

async function runSingleBenchmarkPass(
  context: Context,
  BenchmarkClass: BenchmarkConstructor,
  ClientClass: ClientConstructor,
  example: Example,
  phase: Event.Phase,
  { verify = false } = {},
) {
  try {
    const benchmark: Benchmark = new BenchmarkClass(new ClientClass(), example);
    await benchmark.setup();

    // force gc in Node to have clear memory readings
    if (global.gc) {
      global.gc();
    }

    const start = performanceNow();
    await benchmark.run();
    const duration = performanceNow() - start;

    // force gc again and perform readigns
    let memoryReadings;
    if (global.gc) {
      const { memoryUsage } = require('process');
      global.gc();
      memoryReadings = memoryUsage();
    }

    if (verify) {
      await benchmark.verify();
    }
    await benchmark.teardown();

    // Yield the run loop.
    await new Promise(resolve => setTimeout(resolve, 0));

    return { duration, memoryUsage: memoryReadings };
  } catch (error) {
    context.failure = { error, phase };
    console.log('ERROR: ', error);
    return undefined;
  }
}

function percentRelativeMarginOfError(stats: Stats) {
  return (stats.moe() / stats.amean()) * 100;
}

function statsSummary(
  stats: Stats,
  heapUsedStats: Stats,
  heapTotalStats: Stats,
  heapUsedBase: number,
  heapTotalBase: number,
): Event.ClientBenchmarkStats {
  const [min, max] = stats.range();
  return {
    iterations: stats.length,
    min,
    mean: stats.amean(),
    max,
    marginOfError: stats.moe(),
    percentRelativeMarginOfError: percentRelativeMarginOfError(stats),
    memoryUsage: {
      heapUsed: heapUsedStats.amean(),
      heapTotal: heapTotalStats.amean(),
      heapUsedBase,
      heapTotalBase,
    },
  };
}

export function saveData(name: string, stat: number) {
  if (!global.gc) return;

  const { readFile, writeFile } = require('fs');
  // read the file
  readFile('./findings.json', { encoding: 'utf8', flag: 'a+' }, (err, data) => {
    if (err) {
      console.error(`Error while reading file: ${err}`);
      return;
    }
    const normalized = stat.toFixed(3);

    let updatedData;
    try {
      // parse JSON string to JSON object
      updatedData = JSON.parse(data);
    } catch (error) {
      updatedData = {};
    }

    // add a new record
    if (name in updatedData) updatedData[name].push(normalized);
    else updatedData[name] = [normalized];

    // write new data back to the file
    writeFile('./findings.json', JSON.stringify(updatedData, null, 2), err => {
      if (err) console.log(`Error writing file: ${err}`);
      return;
    });
  });
}
