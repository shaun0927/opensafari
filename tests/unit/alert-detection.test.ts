import path from 'path';
import fs from 'fs';
import { AXNode } from '../../src/native/ax-types';
import {
  findAlertCandidates,
  collectVisibleButtonLabels,
  collectVisibleStaticTexts,
  DialogDetectionContext,
} from '../../src/tools/alert-detection';

const FIXTURES_DIR = path.join(__dirname, '../fixtures/ax-trees');

function loadFixture(name: string): AXNode {
  const raw = fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf-8');
  return JSON.parse(raw) as AXNode;
}

const DEVICE_WIDTH = 393;

function ctx(tree: AXNode): DialogDetectionContext {
  return { tree, deviceWidth: DEVICE_WIDTH };
}

describe('findAlertCandidates — maps-ko-location', () => {
  const tree = loadFixture('maps-ko-location.json');

  test('accept: finds ≥1 candidate', () => {
    const candidates = findAlertCandidates('accept', ctx(tree));
    expect(candidates.length).toBeGreaterThanOrEqual(1);
  });

  test('accept: first candidate label is an accept option', () => {
    const candidates = findAlertCandidates('accept', ctx(tree));
    const acceptLabels = new Set(['한 번 허용', '앱을 사용하는 동안 허용']);
    expect(acceptLabels.has(candidates[0].label)).toBe(true);
  });

  test('accept: first candidate reason is ancestor_is_dialog or geometry_bounded', () => {
    const candidates = findAlertCandidates('accept', ctx(tree));
    const validReasons = new Set(['ancestor_is_dialog', 'geometry_bounded']);
    expect(validReasons.has(candidates[0].reason)).toBe(true);
  });

  test('dismiss: finds exactly 1 candidate', () => {
    const candidates = findAlertCandidates('dismiss', ctx(tree));
    expect(candidates).toHaveLength(1);
  });

  test('dismiss: label is 허용 안 함', () => {
    const candidates = findAlertCandidates('dismiss', ctx(tree));
    expect(candidates[0].label).toBe('허용 안 함');
  });
});

describe('findAlertCandidates — photos-en-permission', () => {
  const tree = loadFixture('photos-en-permission.json');

  test('accept: finds Allow', () => {
    const candidates = findAlertCandidates('accept', ctx(tree));
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    expect(candidates[0].label).toBe('Allow');
  });
});

describe('findAlertCandidates — att-tracking', () => {
  const tree = loadFixture('att-tracking.json');

  test('accept: finds Allow', () => {
    const candidates = findAlertCandidates('accept', ctx(tree));
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    expect(candidates[0].label).toBe('Allow');
  });
});

describe('findAlertCandidates — in-app-ok (clause 3 rejection)', () => {
  const tree = loadFixture('in-app-ok.json');

  test('accept: finds NO candidates because identifier-tagged button exists', () => {
    const candidates = findAlertCandidates('accept', ctx(tree));
    expect(candidates).toHaveLength(0);
  });
});

describe('findAlertCandidates — springboard-dialog (geometry_bounded)', () => {
  const tree = loadFixture('springboard-dialog.json');

  test('accept: finds Continue via geometry bound', () => {
    const candidates = findAlertCandidates('accept', ctx(tree));
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    const labels = candidates.map(c => c.label);
    expect(labels).toContain('Continue');
  });
});

describe('findAlertCandidates — notifications-ko-nbsp (issue #642)', () => {
  const tree = loadFixture('notifications-ko-nbsp.json');

  test('dismiss: finds the NBSP-separated 허용 안 함 button', () => {
    const candidates = findAlertCandidates('dismiss', ctx(tree));
    expect(candidates).toHaveLength(1);
    expect(candidates[0].label).toBe('허용 안 함');
  });

  test('dismiss: candidate AX node label retains its NBSP separators', () => {
    const candidates = findAlertCandidates('dismiss', ctx(tree));
    const NBSP = ' ';
    expect(candidates[0].node.label).toBe(`허용${NBSP}안${NBSP}함`);
  });

  test('accept: finds the 허용 button', () => {
    const candidates = findAlertCandidates('accept', ctx(tree));
    expect(candidates).toHaveLength(1);
    expect(candidates[0].label).toBe('허용');
  });
});

describe('findAlertCandidates — spotlight-search (non-match)', () => {
  const tree = loadFixture('spotlight-search.json');

  test('accept: finds no candidates', () => {
    const candidates = findAlertCandidates('accept', ctx(tree));
    expect(candidates).toHaveLength(0);
  });
});

describe('collectVisibleButtonLabels', () => {
  test('maps-ko-location: returns all 3 button labels', () => {
    const tree = loadFixture('maps-ko-location.json');
    const labels = collectVisibleButtonLabels(tree);
    expect(labels).toContain('한 번 허용');
    expect(labels).toContain('앱을 사용하는 동안 허용');
    expect(labels).toContain('허용 안 함');
    expect(labels).toHaveLength(3);
  });
});

describe('collectVisibleStaticTexts', () => {
  test('photos-en-permission: returns the heading text', () => {
    const tree = loadFixture('photos-en-permission.json');
    const texts = collectVisibleStaticTexts(tree);
    expect(texts).toContain('Allow "App" to access your Photos?');
  });
});

describe('empty tree edge cases', () => {
  const emptyTree: AXNode = {
    role: 'AXApplication',
    traits: [],
    frame: { x: 0, y: 0, width: 393, height: 852 },
    visible: true,
    enabled: true,
    focused: false,
    path: '0',
  };

  test('findAlertCandidates returns [] for empty tree', () => {
    expect(findAlertCandidates('accept', ctx(emptyTree))).toEqual([]);
    expect(findAlertCandidates('dismiss', ctx(emptyTree))).toEqual([]);
  });

  test('collectVisibleButtonLabels returns [] for empty tree', () => {
    expect(collectVisibleButtonLabels(emptyTree)).toEqual([]);
  });

  test('collectVisibleStaticTexts returns [] for empty tree', () => {
    expect(collectVisibleStaticTexts(emptyTree)).toEqual([]);
  });
});
