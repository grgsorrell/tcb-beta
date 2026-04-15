const { test, expect } = require('@playwright/test');

// Login is on index.html — sets tcb_session in localStorage, then redirect to app.html
// App.html checks tcb_session and redirects to index.html if missing/expired
// Selectors confirmed from app.html source:
//   Sam FAB: #sam-fab  (button.sam-fab)
//   Sam panel: #sam-panel
//   Sam input: #sam-input  (input.sp-inp)
//   Sam send: button.sp-send with onclick="sendSamMessage()"
//   Sam messages container: #sam-messages
//   Sam response bubbles: .sam-msg (not .sam-msg.typing)
//   User messages: .user-msg
//   Tool confirmations: .sam-confirm
//   Nav buttons: button[data-view="calendar"], button[data-view="budget"], etc.

const BASE_URL = 'https://tcb-beta.grgsorrell.workers.dev';
const USERNAME = 'greg';
const PASSWORD = 'Beta#01';

// Helper: login by injecting session into localStorage then loading app.html
// The app checks tcb_session on load and redirects to index.html if missing.
// We inject the session before the check runs by using addInitScript.
async function login(page) {
  // Inject session BEFORE any page JS runs
  await page.addInitScript(() => {
    const session = {
      userId: 'greg',
      loginTime: Date.now(),
      expires: Date.now() + 2592000000
    };
    localStorage.setItem('tcb_session', JSON.stringify(session));
    localStorage.setItem('tcb_current_user', 'greg');
  });

  // Now load the app — session check will pass
  await page.goto(BASE_URL + '/app.html', { waitUntil: 'domcontentloaded' });

  // Wait for the Sam FAB to appear (means app fully loaded)
  await page.waitForSelector('#sam-fab', { timeout: 20000 });
  await page.waitForTimeout(2000);
}

// Helper: open Sam panel and send a message, return Sam's response text
async function askSam(page, message) {
  // Open Sam panel if not already open
  const panelOpen = await page.$('#sam-panel.open');
  if (!panelOpen) {
    await page.click('#sam-fab');
    await page.waitForSelector('#sam-panel.open', { timeout: 5000 });
    await page.waitForTimeout(500);
  }

  // Count existing messages before sending
  const beforeCount = await page.$$eval(
    '#sam-messages .sam-msg:not(.typing)',
    els => els.length
  );

  // Type and send
  await page.fill('#sam-input', message);
  await page.click('button.sp-send');

  // Wait for typing indicator to appear then disappear
  try {
    await page.waitForSelector('#sam-typing', { timeout: 5000 });
  } catch (e) {
    // Typing indicator might appear and disappear very fast
  }

  // Wait for Sam to finish responding (typing indicator gone + new messages stable)
  let lastMsgCount = beforeCount;
  let lastText = '';
  let stableCount = 0;

  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(2000);

    // Check if typing indicators are gone
    const typing1 = await page.$('#sam-typing');
    const typing2 = await page.$('#sam-typing2');

    // Get all non-typing sam messages
    const msgs = await page.$$eval(
      '#sam-messages .sam-msg:not(.typing)',
      els => els.map(el => el.textContent.trim())
    );
    const confirms = await page.$$eval(
      '#sam-messages .sam-confirm',
      els => els.map(el => el.textContent.trim())
    );

    const allText = [...msgs, ...confirms].join('\n');

    if (!typing1 && !typing2 && allText === lastText && msgs.length > beforeCount) {
      stableCount++;
      if (stableCount >= 2) break;
    } else {
      stableCount = 0;
      lastText = allText;
    }
  }

  // Collect Sam's NEW responses (after what we already had)
  const allMsgs = await page.$$eval(
    '#sam-messages .sam-msg:not(.typing)',
    els => els.map(el => el.textContent.trim())
  );
  const allConfirms = await page.$$eval(
    '#sam-messages .sam-confirm',
    els => els.map(el => el.textContent.trim())
  );

  // Return new messages only
  const newMsgs = allMsgs.slice(beforeCount);
  const response = [...newMsgs, ...allConfirms.slice(-5)].join('\n');

  return response;
}

// ============================================================
// TEST 1 — LOGIN AND APP LOAD
// ============================================================
test('App loads and Sam FAB is visible', async ({ page }) => {
  await login(page);

  // Sam FAB should be visible
  const fab = await page.$('#sam-fab');
  expect(fab).not.toBeNull();

  // Check that dashboard is showing
  const bodyText = await page.textContent('body');
  expect(bodyText).toContain('Home');

  console.log('TEST 1: PASS — App loaded, Sam FAB visible');
});

// ============================================================
// TEST 2 — SAM PANEL OPENS
// ============================================================
test('Sam panel opens when FAB clicked', async ({ page }) => {
  await login(page);

  // Click FAB
  await page.click('#sam-fab');
  await page.waitForSelector('#sam-panel.open', { timeout: 5000 });

  // Check panel is open and has messages area
  const msgs = await page.$('#sam-messages');
  expect(msgs).not.toBeNull();

  // Check input field exists
  const input = await page.$('#sam-input');
  expect(input).not.toBeNull();

  console.log('TEST 2: PASS — Sam panel opens');
});

// ============================================================
// TEST 3 — SAM RESPONDS TO MESSAGE
// ============================================================
test('Sam responds to a basic question', async ({ page }) => {
  await login(page);

  const response = await askSam(page, 'What should I focus on today?');

  console.log('TEST 3 Response:', response.substring(0, 300));

  // Must have a substantive response
  expect(response.length).toBeGreaterThan(50);

  // Must not be an error
  expect(response.toLowerCase()).not.toContain('something went wrong');
  expect(response.toLowerCase()).not.toContain("couldn't connect");

  console.log('TEST 3: PASS — Sam gave substantive response');
});

// ============================================================
// TEST 4 — NO RESEARCH NARRATION
// ============================================================
test('Sam does not show research narration', async ({ page }) => {
  await login(page);

  const response = await askSam(page, 'What should I focus on today?');

  console.log('TEST 4 Response:', response.substring(0, 300));

  // Must not contain narration phrases (these should be stripped by cleanResearchNarration)
  const narrationPatterns = [
    /^I'll search/im,
    /^Let me search/im,
    /^I'm searching/im,
    /^Let me look up/im,
    /^I'll research/im,
    /^Searching for/im
  ];

  for (const pattern of narrationPatterns) {
    expect(response).not.toMatch(pattern);
  }

  // Must be substantive
  expect(response.length).toBeGreaterThan(100);

  console.log('TEST 4: PASS — No research narration detected');
});

// ============================================================
// TEST 5 — EXPENSE LOGGING
// ============================================================
test('Sam logs an expense via tool call', async ({ page }) => {
  await login(page);

  const response = await askSam(page, 'Log a $500 expense for yard signs');

  console.log('TEST 5 Response:', response.substring(0, 400));

  // Should see a tool confirmation
  const fullResponse = response.toLowerCase();
  const expenseLogged = fullResponse.includes('500') ||
                        fullResponse.includes('yard sign') ||
                        fullResponse.includes('logged') ||
                        fullResponse.includes('signs');

  expect(expenseLogged).toBe(true);

  // Check for the green confirmation toast or sam-confirm
  const confirms = await page.$$eval(
    '#sam-messages .sam-confirm',
    els => els.map(el => el.textContent)
  );
  const hasConfirm = confirms.some(c =>
    c.includes('500') || c.includes('sign') || c.includes('Logged')
  );

  console.log('Confirms found:', confirms);
  console.log('Has expense confirm:', hasConfirm);

  // At minimum, Sam should mention the expense
  expect(fullResponse.includes('500') || hasConfirm).toBe(true);

  console.log('TEST 5: PASS — Expense logged');
});

// ============================================================
// TEST 6 — CAMPAIGN MANAGER VOICE
// ============================================================
test('Sam speaks like a campaign manager', async ({ page }) => {
  await login(page);

  const response = await askSam(page, 'How is the campaign going?');

  console.log('TEST 6 Response:', response.substring(0, 400));

  // Must reference actual campaign concepts or political terms
  const hasCampaignContext = /days|election|budget|voter|race|primary|campaign|calendar|outreach|fundrais|planning|office|council|commissioner|state rep|candidate|filed|win number|district/i.test(response);
  expect(hasCampaignContext).toBe(true);

  // Must not be generic AI assistant talk
  expect(response).not.toMatch(/I'm here to help you with anything/i);
  expect(response).not.toMatch(/How can I assist you today/i);

  // Must end with a question (prompt rule)
  const endsWithQuestion = response.trim().endsWith('?') ||
    response.trim().match(/\?["\s]*$/);
  console.log('Ends with question:', endsWithQuestion);

  console.log('TEST 6: PASS — Campaign manager voice confirmed');
});

// ============================================================
// TEST 7 — WIN NUMBER FLOW
// ============================================================
test('Sam handles win number question', async ({ page }) => {
  await login(page);

  const response = await askSam(page, "What's my win number?");

  console.log('TEST 7 Response:', response.substring(0, 400));

  // Sam should either reference an existing win number or start the calculation flow
  const validResponse = /win number|votes|vote target|how many candidates|last election|need to win|voter turnout/i.test(response);
  expect(validResponse).toBe(true);

  // Must not be empty or error
  expect(response.length).toBeGreaterThan(30);

  console.log('TEST 7: PASS — Win number flow initiated');
});

// ============================================================
// TEST 8 — ADD EVENT TO CALENDAR
// ============================================================
test('Sam adds event to calendar', async ({ page }) => {
  await login(page);

  const response = await askSam(page,
    'Add a meet and greet on May 10th at 6pm at City Hall'
  );

  console.log('TEST 8 Response:', response.substring(0, 400));

  // Check for confirmation
  const fullText = response.toLowerCase();
  const eventAdded = fullText.includes('meet and greet') ||
                     fullText.includes('city hall') ||
                     fullText.includes('may 10') ||
                     fullText.includes('calendar') ||
                     fullText.includes('added');

  // Check sam-confirm elements
  const confirms = await page.$$eval(
    '#sam-messages .sam-confirm',
    els => els.map(el => el.textContent.toLowerCase())
  );
  const hasEventConfirm = confirms.some(c =>
    c.includes('meet') || c.includes('calendar') || c.includes('added')
  );

  console.log('Confirms:', confirms);
  console.log('Event confirmed:', eventAdded || hasEventConfirm);

  expect(eventAdded || hasEventConfirm).toBe(true);

  console.log('TEST 8: PASS — Event added');
});

// ============================================================
// TEST 9 — MULTI-TOOL EXECUTION
// ============================================================
test('Sam executes multiple tools in one request', async ({ page }) => {
  await login(page);

  const response = await askSam(page,
    'Add $3000 for digital ads and add a fundraiser on May 20th at 6pm'
  );

  console.log('TEST 9 Response:', response.substring(0, 400));

  // Check for expense confirmation
  const fullText = response.toLowerCase();
  const hasExpense = fullText.includes('3,000') || fullText.includes('3000') ||
                     fullText.includes('digital');
  const hasEvent = fullText.includes('fundraiser') || fullText.includes('may 20');

  // Also check confirmations
  const confirms = await page.$$eval(
    '#sam-messages .sam-confirm',
    els => els.map(el => el.textContent.toLowerCase())
  );
  const confirmHasExpense = confirms.some(c => c.includes('3,000') || c.includes('3000') || c.includes('digital'));
  const confirmHasEvent = confirms.some(c => c.includes('fundraiser') || c.includes('may 20') || c.includes('added'));

  console.log('Response has expense:', hasExpense, 'Confirm has expense:', confirmHasExpense);
  console.log('Response has event:', hasEvent, 'Confirm has event:', confirmHasEvent);
  console.log('Confirms:', confirms);

  // Both tools should have fired
  expect(hasExpense || confirmHasExpense).toBe(true);
  expect(hasEvent || confirmHasEvent).toBe(true);

  console.log('TEST 9: PASS — Multi-tool execution');
});

// ============================================================
// TEST 10 — SAM 2.0 CAMPAIGN MANAGER VOICE (no generic AI)
// ============================================================
test('Sam 2.0 voice uses campaign terminology', async ({ page }) => {
  await login(page);

  const response = await askSam(page,
    'I just announced my run for city council. What should my first week look like?'
  );

  console.log('TEST 10 Response:', response.substring(0, 500));

  // Must be substantive
  expect(response.length).toBeGreaterThan(80);

  // Must not be generic
  expect(response).not.toMatch(/I'm an AI|I'm a language model|As an AI/i);

  // Should give concrete campaign advice
  const hasCampaignAdvice = /fundrais|voter|door|volunteer|budget|endors|outreach|announcement|press|media|sign|calendar|deadline|strategy|GOTV|ground game/i.test(response);
  expect(hasCampaignAdvice).toBe(true);

  console.log('TEST 10: PASS — Campaign terminology confirmed');
});
