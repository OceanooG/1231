import { bitable } from '@lark-base-open/js-sdk';

/**
 * 配置区：把这三个名字改成你表里的列名（务必和显示名一致）
 */
const FIELD_PAYABLE = '应付工资';
const FIELD_ACTUAL  = '实付工资';
const FIELD_OT_NET  = '税后加班费';

/**
 * 可选：每步递增的“视觉延迟”（毫秒）。设为 0 则不延时、快速完成。
 * 想看到数字一点点跳动，可设 20~50。
 */
const STEP_DELAY_MS = 0;

/**
 * 安全循环上限，防止异常数据造成“无限循环”
 * 上限设置为差额的 2 倍 + 10（计算时会用 Math.min 取更小的）
 */
const MAX_LOOP_HARD_CAP = 20000;

/** 小工具：睡眠 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** 根据字段名拿字段ID（没有就抛错） */
async function getFieldIdsByNames(table, names) {
  const fields = await table.getFields();
  const nameToId = {};
  for (const n of names) {
    const id = fields.find(f => f.name === n)?.id;
    if (!id) {
      throw new Error(`未找到字段：${n}（请确认列名是否与 UI 完全一致）`);
    }
    nameToId[n] = id;
  }
  return nameToId;
}

/** 读取单元格数值（允许空，数字字符串会转 number） */
async function getNumberCell(table, recordId, fieldId) {
  const v = await table.getCellValue(recordId, fieldId);
  if (v === null || v === undefined || v === '') return null;
  // Base 的数值/文本不同类型，这里尽量转 number
  const num = Number(v.value ?? v); // 兼容 { value: 123 } 或 123
  return Number.isFinite(num) ? num : null;
}

/** 写入单元格数值 */
async function setNumberCell(table, recordId, fieldId, num) {
  await table.setCellValue(recordId, fieldId, num);
}

/**
 * 核心：处理一条记录
 * 逻辑：
 * - 若 税后加班费 为空 -> 不处理
 * - 若 不为空：
 *     循环把 应付工资 朝 实付工资 方向每次移动 1（你的需求是 +1，但也防护“应付>实付”时 -1）
 *     直到相等或达到安全上限
 */
async function adjustOne(recordId) {
  const table = await bitable.base.getActiveTable();
  const ids = await getFieldIdsByNames(table, [FIELD_PAYABLE, FIELD_ACTUAL, FIELD_OT_NET]);

  const otNet = await getNumberCell(table, recordId, ids[FIELD_OT_NET]);
  if (otNet === null) {
    // 税后加班费为空，不处理
    return { recordId, changed: false, reason: 'OT_NET_EMPTY' };
  }

  let payable = await getNumberCell(table, recordId, ids[FIELD_PAYABLE]);
  const actual  = await getNumberCell(table, recordId, ids[FIELD_ACTUAL]);

  if (payable === null || actual === null) {
    return { recordId, changed: false, reason: 'PAYABLE_OR_ACTUAL_NULL' };
  }

  if (payable === actual) {
    return { recordId, changed: false, reason: 'ALREADY_EQUAL' };
  }

  // 计算差额与方向（你的场景通常 actual > payable，方向为 +1）
  const diff = actual - payable;
  const step = diff > 0 ? 1 : -1;

  // 合理的循环上限：|diff| 的两倍 + 10（再和硬上限取 min）
  const maxLoops = Math.min(Math.abs(diff) * 2 + 10, MAX_LOOP_HARD_CAP);

  let iter = 0;
  while (payable !== actual && iter < maxLoops) {
    payable += step;
    await setNumberCell(table, recordId, ids[FIELD_PAYABLE], payable);
    iter += 1;
    if (STEP_DELAY_MS > 0) await sleep(STEP_DELAY_MS);
  }

  const finished = payable === actual;
  return {
    recordId,
    changed: finished,
    finalPayable: payable,
    iter,
    reached: finished ? 'MATCHED' : 'MAX_LOOP',
  };
}

/**
 * 入口一：优先处理“当前选中记录”；如果没有选中，则处理当前表的全部记录
 */
export async function adjustSelectedOrAll() {
  const table = await bitable.base.getActiveTable();
  const selection = await bitable.ui.getSelection(); // 若 SDK 版本不支持，可自行改成只处理全表
  let recordIds = [];

  try {
    const ids = selection?.recordIdList;
    if (ids && ids.length) {
      recordIds = ids;
    }
  } catch (_) {
    // 某些版本/权限下可能取不到 selection，忽略，fallback 到全表
  }

  if (!recordIds.length) {
    // 读取全表（可分页；这里只示例一次性取完，若数据量很大需自行分页）
    const records = await table.getRecords();
    recordIds = records.map(r => r.id || r.record_id);
  }

  const results = [];
  for (const rid of recordIds) {
    try {
      const res = await adjustOne(rid);
      results.push(res);
    } catch (e) {
      results.push({ recordId: rid, error: String(e) });
    }
  }

  console.log('调整结果:', results);
  await bitable.ui.showToast({
    toastType: 'success',
    message: `处理完成：${results.filter(r=>r.changed).length}/${results.length} 行已对齐`,
  });
}

/**
 * 入口二：只处理一条（你可以把 recordId 传进来）
 * 用法：await adjustOne('recXXXX');
 */
export async function adjustOneRecord(recordId) {
  const res = await adjustOne(recordId);
  console.log('单条处理结果:', res);
  await bitable.ui.showToast({
    toastType: res.changed ? 'success' : 'warning',
    message: res.changed ? '该行已对齐' : `未改动：${res.reason || '未知原因'}`,
  });
}
