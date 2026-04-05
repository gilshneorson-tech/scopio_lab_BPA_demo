import { createMachine, assign } from 'xstate';

/**
 * 10-step demo state machine for ScopioLabs BMA product demo.
 * Supports multiple languages via DEMO_LANGUAGE env var (default: 'en').
 */

const DEMO_LANGUAGE = process.env.DEMO_LANGUAGE || 'en';

// ─── Step definitions (language-independent) ───

const STEP_DEFS = [
  { id: 'intro',             index: 0, section: 'home',          duration_sec: 45 },
  { id: 'bma_problem',       index: 1, section: 'overview',      duration_sec: 45 },
  { id: 'full_field_imaging', index: 2, section: 'scan_viewer',   duration_sec: 90 },
  { id: 'ai_differential',   index: 3, section: 'ndc_panel',     duration_sec: 90 },
  { id: 'quantification',    index: 4, section: 'quantification', duration_sec: 60 },
  { id: 'remote_access',     index: 5, section: 'remote_access', duration_sec: 60 },
  { id: 'digital_report',    index: 6, section: 'report_export', duration_sec: 60 },
  { id: 'lis_integration',   index: 7, section: 'integration',   duration_sec: 60 },
  { id: 'qa_open',           index: 8, section: 'summary',       duration_sec: 60 },
  { id: 'closing',           index: 9, section: 'home',          duration_sec: 30 },
];

// ─── Localized scripts ───

const SCRIPTS = {
  en: {
    intro: `Hi, I'm {{agent_name}} from Scopio Labs. Thank you for joining today. Over the next 10 minutes, I'll walk you through our Full-Field BMA solution — the world's first FDA-cleared digital bone marrow aspirate application. I'll show you our imaging capabilities, AI-powered differential count, remote access features, and digital reporting. Feel free to ask questions at any time.`,
    bma_problem: `Today, bone marrow aspirate analysis is still largely a manual process. Pathologists manually scan slides under a microscope, counting 200 to 500 cells — a time-consuming process with significant inter-observer variability. Scopio's solution changes this entirely.`,
    full_field_imaging: `Here's where it gets exciting. Our scanner captures the entire bone marrow sample at 100x oil-immersion equivalent resolution — full field of view with no compromise on detail. What you're seeing is a complete digital representation of the aspirate smear. You can zoom, pan, and navigate just as you would under a microscope, but with the entire sample available digitally.`,
    ai_differential: `Our AI engine performs a full nucleated differential count — the NDC. It classifies hundreds of cells across the entire sample, far more than the typical manual 200 to 500 cell count. This dramatically reduces sampling error and gives you a much more representative picture of the marrow composition. The AI highlights each classified cell right on the image.`,
    quantification: `Beyond the differential, we automatically calculate the myeloid-to-erythroid ratio and provide a megakaryocyte count with spatial distribution mapping. These quantitative metrics are generated automatically — no manual counting required.`,
    remote_access: `One of the biggest workflow advantages is remote access. Any authorized hematopathologist can review the full digital sample from anywhere on your secure hospital network. No physical slide transport, no scheduling around microscope availability. This enables remote consultations, second opinions, and flexible staffing models.`,
    digital_report: `Every analysis generates a shareable, traceable digital report. Results are consistent and repeatable across reviewers — eliminating the variability you see with manual reads. Reports can be exported in standard formats and shared with your clinical team.`,
    lis_integration: `We integrate with your existing Laboratory Information System and LIMS. Results flow directly into your workflow — no manual data entry, no risk of transcription errors. The integration team works directly with your IT staff to ensure a smooth connection.`,
    qa_open: `That covers the core capabilities. I'd love to open the floor for any questions you might have — about the technology, implementation, workflow impact, or anything else on your mind.`,
    closing: `Thank you so much for your time today. As a next step, we'd love to arrange a free digital image review using your own slides — done entirely remotely. I'll have our account team follow up with the details. Is there anything else before we wrap up?`,
  },
  fr: {
    intro: `Bonjour, je suis {{agent_name}} de Scopio Labs. Merci de nous rejoindre aujourd'hui. Au cours des 10 prochaines minutes, je vais vous présenter notre solution BMA Full-Field — la première application numérique d'aspirat de moelle osseuse autorisée par la FDA au monde. Je vous montrerai nos capacités d'imagerie, le comptage différentiel assisté par intelligence artificielle, l'accès à distance et la génération de rapports numériques. N'hésitez pas à poser des questions à tout moment.`,
    bma_problem: `Aujourd'hui, l'analyse d'aspirat de moelle osseuse reste en grande partie un processus manuel. Les pathologistes examinent les lames au microscope, comptant entre 200 et 500 cellules — un processus chronophage avec une variabilité inter-observateur significative. La solution de Scopio change complètement la donne.`,
    full_field_imaging: `C'est ici que cela devient passionnant. Notre scanner capture l'intégralité de l'échantillon de moelle osseuse à une résolution équivalente à l'immersion à l'huile 100x — un champ de vision complet sans aucun compromis sur les détails. Ce que vous voyez est une représentation numérique complète du frottis d'aspirat. Vous pouvez zoomer, faire défiler et naviguer comme vous le feriez sous un microscope, mais avec l'intégralité de l'échantillon disponible en numérique.`,
    ai_differential: `Notre moteur d'intelligence artificielle réalise un comptage différentiel nucléé complet — le NDC. Il classifie des centaines de cellules sur l'ensemble de l'échantillon, bien plus que le comptage manuel typique de 200 à 500 cellules. Cela réduit considérablement l'erreur d'échantillonnage et vous donne une image beaucoup plus représentative de la composition de la moelle. L'IA met en évidence chaque cellule classifiée directement sur l'image.`,
    quantification: `Au-delà du différentiel, nous calculons automatiquement le ratio myéloïde-érythroïde et fournissons un comptage de mégacaryocytes avec cartographie de distribution spatiale. Ces métriques quantitatives sont générées automatiquement — aucun comptage manuel requis.`,
    remote_access: `L'un des plus grands avantages pour le flux de travail est l'accès à distance. Tout hématopathologiste autorisé peut examiner l'échantillon numérique complet depuis n'importe où sur le réseau sécurisé de votre hôpital. Pas de transport physique de lames, pas de planification autour de la disponibilité des microscopes. Cela permet des consultations à distance, des seconds avis et des modèles de dotation flexibles.`,
    digital_report: `Chaque analyse génère un rapport numérique partageable et traçable. Les résultats sont cohérents et reproductibles d'un examinateur à l'autre — éliminant la variabilité que l'on observe avec les lectures manuelles. Les rapports peuvent être exportés dans des formats standards et partagés avec votre équipe clinique.`,
    lis_integration: `Nous nous intégrons à votre Système d'Information de Laboratoire et LIMS existants. Les résultats s'intègrent directement dans votre flux de travail — pas de saisie manuelle de données, pas de risque d'erreurs de transcription. L'équipe d'intégration travaille directement avec votre service informatique pour assurer une connexion fluide.`,
    qa_open: `Cela couvre les capacités principales. Je serais ravi d'ouvrir la discussion pour toute question que vous pourriez avoir — sur la technologie, la mise en œuvre, l'impact sur le flux de travail, ou tout autre sujet qui vous intéresse.`,
    closing: `Merci beaucoup pour votre temps aujourd'hui. Comme prochaine étape, nous serions ravis d'organiser une revue d'images numériques gratuite avec vos propres lames — réalisée entièrement à distance. Notre équipe commerciale vous contactera avec les détails. Y a-t-il autre chose avant que nous terminions ?`,
  },
};

const TOPICS = {
  en: ['Intro + agenda', 'The BMA problem today', 'Full-Field imaging at 100x', 'AI differential count', 'M:E ratio + megakaryocyte count', 'Remote access + collaboration', 'Digital report generation', 'LIS / LIMS integration', 'Q&A open floor', 'Close + next steps'],
  fr: ['Introduction + ordre du jour', 'Le problème du BMA aujourd\'hui', 'Imagerie Full-Field à 100x', 'Comptage différentiel par IA', 'Ratio M:E + comptage de mégacaryocytes', 'Accès à distance + collaboration', 'Génération de rapports numériques', 'Intégration LIS / LIMS', 'Questions-réponses', 'Conclusion + prochaines étapes'],
};

// ─── Build localized demo steps ───

function getDemoSteps(language = DEMO_LANGUAGE) {
  const lang = SCRIPTS[language] ? language : 'en';
  const scripts = SCRIPTS[lang];
  const topics = TOPICS[lang];

  return STEP_DEFS.map((def, i) => ({
    ...def,
    topic: topics[i],
    script: scripts[def.id],
    browser_action: { action_type: 'NAVIGATE', section: def.section },
  }));
}

const DEMO_STEPS = getDemoSteps();

// ─── State machine ───

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

export { demoMachine, DEMO_STEPS, getDemoSteps, DEMO_LANGUAGE };
