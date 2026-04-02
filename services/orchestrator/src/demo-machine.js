import { createMachine, assign } from 'xstate';

/**
 * 10-step demo state machine for ScopioLabs BMA product demo.
 *
 * States: idle → joining → intro → demo_step_1..8 → qa → closing → ended
 *
 * Events:
 *  - START            → begin the demo session
 *  - PROSPECT_JOINED  → prospect entered the call
 *  - ADVANCE          → move to next demo step
 *  - ANSWER           → answer a question mid-step, then resume
 *  - REPEAT           → re-explain current step
 *  - PROSPECT_LEFT    → prospect dropped off
 *  - CLOSE            → wrap up the demo
 *  - ERROR            → unrecoverable error
 */

const DEMO_STEPS = [
  {
    id: 'intro',
    index: 0,
    topic: 'Intro + agenda',
    section: 'home',
    duration_sec: 45,
    script: `Hi, I'm {{agent_name}} from Scopio Labs. Thank you for joining today. Over the next 10 minutes, I'll walk you through our Full-Field BMA solution — the world's first FDA-cleared digital bone marrow aspirate application. I'll show you our imaging capabilities, AI-powered differential count, remote access features, and digital reporting. Feel free to ask questions at any time.`,
    browser_action: { action_type: 'NAVIGATE', section: 'home' },
  },
  {
    id: 'bma_problem',
    index: 1,
    topic: 'The BMA problem today',
    section: 'overview',
    duration_sec: 45,
    script: `Today, bone marrow aspirate analysis is still largely a manual process. Pathologists manually scan slides under a microscope, counting 200 to 500 cells — a time-consuming process with significant inter-observer variability. Scopio's solution changes this entirely.`,
    browser_action: { action_type: 'NAVIGATE', section: 'overview' },
  },
  {
    id: 'full_field_imaging',
    index: 2,
    topic: 'Full-Field imaging at 100x',
    section: 'scan_viewer',
    duration_sec: 90,
    script: `Here's where it gets exciting. Our scanner captures the entire bone marrow sample at 100x oil-immersion equivalent resolution — full field of view with no compromise on detail. What you're seeing is a complete digital representation of the aspirate smear. You can zoom, pan, and navigate just as you would under a microscope, but with the entire sample available digitally.`,
    browser_action: { action_type: 'NAVIGATE', section: 'scan_viewer' },
  },
  {
    id: 'ai_differential',
    index: 3,
    topic: 'AI differential count',
    section: 'ndc_panel',
    duration_sec: 90,
    script: `Our AI engine performs a full nucleated differential count — the NDC. It classifies hundreds of cells across the entire sample, far more than the typical manual 200 to 500 cell count. This dramatically reduces sampling error and gives you a much more representative picture of the marrow composition. The AI highlights each classified cell right on the image.`,
    browser_action: { action_type: 'NAVIGATE', section: 'ndc_panel' },
  },
  {
    id: 'quantification',
    index: 4,
    topic: 'M:E ratio + megakaryocyte count',
    section: 'quantification',
    duration_sec: 60,
    script: `Beyond the differential, we automatically calculate the myeloid-to-erythroid ratio and provide a megakaryocyte count with spatial distribution mapping. These quantitative metrics are generated automatically — no manual counting required.`,
    browser_action: { action_type: 'NAVIGATE', section: 'quantification' },
  },
  {
    id: 'remote_access',
    index: 5,
    topic: 'Remote access + collaboration',
    section: 'remote_access',
    duration_sec: 60,
    script: `One of the biggest workflow advantages is remote access. Any authorized hematopathologist can review the full digital sample from anywhere on your secure hospital network. No physical slide transport, no scheduling around microscope availability. This enables remote consultations, second opinions, and flexible staffing models.`,
    browser_action: { action_type: 'NAVIGATE', section: 'remote_access' },
  },
  {
    id: 'digital_report',
    index: 6,
    topic: 'Digital report generation',
    section: 'report_export',
    duration_sec: 60,
    script: `Every analysis generates a shareable, traceable digital report. Results are consistent and repeatable across reviewers — eliminating the variability you see with manual reads. Reports can be exported in standard formats and shared with your clinical team.`,
    browser_action: { action_type: 'NAVIGATE', section: 'report_export' },
  },
  {
    id: 'lis_integration',
    index: 7,
    topic: 'LIS / LIMS integration',
    section: 'integration',
    duration_sec: 60,
    script: `We integrate with your existing Laboratory Information System and LIMS. Results flow directly into your workflow — no manual data entry, no risk of transcription errors. The integration team works directly with your IT staff to ensure a smooth connection.`,
    browser_action: { action_type: 'NAVIGATE', section: 'integration' },
  },
  {
    id: 'qa_open',
    index: 8,
    topic: 'Q&A open floor',
    section: 'summary',
    duration_sec: 60,
    script: `That covers the core capabilities. I'd love to open the floor for any questions you might have — about the technology, implementation, workflow impact, or anything else on your mind.`,
    browser_action: { action_type: 'NAVIGATE', section: 'summary' },
  },
  {
    id: 'closing',
    index: 9,
    topic: 'Close + next steps',
    section: 'home',
    duration_sec: 30,
    script: `Thank you so much for your time today. As a next step, we'd love to arrange a free digital image review using your own slides — done entirely remotely. I'll have our account team follow up with the details. Is there anything else before we wrap up?`,
    browser_action: { action_type: 'NAVIGATE', section: 'home' },
  },
];

const demoMachine = createMachine({
  id: 'demo',
  initial: 'idle',
  context: {
    callId: null,
    prospectName: null,
    currentStep: 0,
    conversationHistory: [],
    startedAt: null,
    stepsCompleted: 0,
    lastError: null,
  },
  states: {
    idle: {
      on: {
        START: {
          target: 'joining',
          actions: assign({
            callId: ({ event }) => event.callId,
            prospectName: ({ event }) => event.prospectName || null,
            startedAt: () => Date.now(),
            currentStep: 0,
            conversationHistory: [],
            stepsCompleted: 0,
          }),
        },
      },
    },

    joining: {
      on: {
        PROSPECT_JOINED: {
          target: 'presenting',
          actions: assign({
            prospectName: ({ context, event }) =>
              event.prospectName || context.prospectName,
          }),
        },
        ERROR: {
          target: 'error',
          actions: assign({ lastError: ({ event }) => event.error }),
        },
      },
    },

    presenting: {
      on: {
        ADVANCE: [
          {
            guard: ({ context }) => context.currentStep < DEMO_STEPS.length - 1,
            actions: assign({
              currentStep: ({ context }) => context.currentStep + 1,
              stepsCompleted: ({ context }) => context.stepsCompleted + 1,
            }),
          },
          {
            target: 'ended',
            actions: assign({
              stepsCompleted: ({ context }) => context.stepsCompleted + 1,
            }),
          },
        ],
        ANSWER: {
          actions: assign({
            conversationHistory: ({ context, event }) => [
              ...context.conversationHistory,
              { role: 'prospect', text: event.question, timestamp: Date.now() },
              { role: 'agent', text: event.answer, timestamp: Date.now() },
            ],
          }),
        },
        REPEAT: {},
        CLOSE: 'ended',
        PROSPECT_LEFT: 'ended',
        ERROR: {
          target: 'error',
          actions: assign({ lastError: ({ event }) => event.error }),
        },
      },
    },

    error: {
      on: {
        START: 'idle',
      },
    },

    ended: {
      type: 'final',
    },
  },
});

export { demoMachine, DEMO_STEPS };
