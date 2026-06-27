import * as fc from 'fast-check';

// Global property-based testing default for the whole suite.
// Every fast-check property runs a minimum of 100 iterations unless a test
// explicitly overrides numRuns for a specific property.
fc.configureGlobal({ numRuns: 100 });
