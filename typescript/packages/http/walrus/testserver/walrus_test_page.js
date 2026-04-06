import { createPublicClient, http } from "viem";
import {
  DEFAULT_WALRUS_RPC_URL,
  DEFAULT_WALRUS_VERIFIER_CONTRACT_ADDRESS,
  createWalrusClient,
  encodeWalrusSignature,
  verifyWalrusBatchTreeItemSignature,
  verifyWalrusBatchTreeSignatures,
} from "@x402/walrus";

const state = {
  loadedTree: null,
  selectedItem: null,
};

const elements = {
  aggregatorUrl: document.getElementById("aggregatorUrl"),
  blobId: document.getElementById("blobId"),
  teeId: document.getElementById("teeId"),
  inputHash: document.getElementById("inputHash"),
  outputHash: document.getElementById("outputHash"),
  teeSignature: document.getElementById("teeSignature"),
  teeTimestamp: document.getElementById("teeTimestamp"),
  signatureEncoding: document.getElementById("signatureEncoding"),
  rpcUrl: document.getElementById("rpcUrl"),
  verifierContractAddress: document.getElementById("verifierContractAddress"),
  fetchBlobButton: document.getElementById("fetchBlobButton"),
  verifyItemButton: document.getElementById("verifyItemButton"),
  verifyBlobButton: document.getElementById("verifyBlobButton"),
  status: document.getElementById("status"),
  blobIdStat: document.getElementById("blobIdStat"),
  blobRootStat: document.getElementById("blobRootStat"),
  itemCountStat: document.getElementById("itemCountStat"),
  itemsTableBody: document.getElementById("itemsTableBody"),
  selectedPayloadOutput: document.getElementById("selectedPayloadOutput"),
  verificationOutput: document.getElementById("verificationOutput"),
};

elements.rpcUrl.value ||= DEFAULT_WALRUS_RPC_URL;
elements.verifierContractAddress.value ||= DEFAULT_WALRUS_VERIFIER_CONTRACT_ADDRESS;

elements.fetchBlobButton.addEventListener("click", () => {
  void onFetchBlob();
});

elements.verifyItemButton.addEventListener("click", () => {
  void onVerifyItem();
});

elements.verifyBlobButton.addEventListener("click", () => {
  void onVerifyBlob();
});

async function onFetchBlob() {
  setStatus("Fetching Walrus batch tree from the aggregator...", "success");
  setButtonState(true);

  try {
    const walrus = createWalrusClient({
      baseUrl: requireValue(elements.aggregatorUrl.value, "Aggregator URL"),
    });
    const blobId = requireValue(elements.blobId.value, "Blob ID");
    const loadedTree = await walrus.fetchBatchTree(blobId);

    state.loadedTree = loadedTree;
    state.selectedItem = null;

    elements.blobIdStat.textContent = loadedTree.blobId;
    elements.blobRootStat.textContent = loadedTree.merkleRoot;
    elements.itemCountStat.textContent = String(loadedTree.items.length);
    elements.verificationOutput.textContent = "No verification run yet.";

    renderItems(loadedTree.items);

    if (loadedTree.items.length > 0) {
      applyItemToForm(loadedTree.items[0]);
      setStatus(
        `Fetched blob ${loadedTree.blobId}.\nDecoded ${loadedTree.items.length} batch item(s). First item loaded into the form.`,
        "success",
      );
      return;
    }

    elements.selectedPayloadOutput.textContent = "Blob contains no items.";
    setStatus(`Fetched blob ${loadedTree.blobId}, but it contains no batch items.`, "error");
  } catch (error) {
    setStatus(formatError(error), "error");
  } finally {
    setButtonState(false);
  }
}

async function onVerifyItem() {
  setStatus("Calling verifySignatureNoTimestamp(...) for the current form values...", "success");
  setButtonState(true);

  try {
    const item = readFormItem();
    const publicClient = createPublicClient({
      transport: http(requireValue(elements.rpcUrl.value, "RPC URL")),
    });

    const verified = await verifyWalrusBatchTreeItemSignature({
      item,
      verifierContractAddress: requireValue(
        elements.verifierContractAddress.value,
        "Verifier contract address",
      ),
      publicClient,
    });

    elements.selectedPayloadOutput.textContent = JSON.stringify(item, null, 2);
    elements.verificationOutput.textContent = JSON.stringify(
      {
        mode: "single-item",
        verified,
        verifierContractAddress: normalizeAddress(
          elements.verifierContractAddress.value,
          "Verifier contract address",
        ),
        item,
      },
      null,
      2,
    );

    setStatus(
      `verifySignatureNoTimestamp(...) completed for the current item.\nResult: ${verified ? "valid" : "invalid"}`,
      verified ? "success" : "error",
    );
  } catch (error) {
    setStatus(formatError(error), "error");
  } finally {
    setButtonState(false);
  }
}

async function onVerifyBlob() {
  setStatus("Calling verifySignatureNoTimestamp(...) for every item in the loaded blob...", "success");
  setButtonState(true);

  try {
    if (!state.loadedTree) {
      throw new Error("Load a blob first before verifying the full batch.");
    }

    const publicClient = createPublicClient({
      transport: http(requireValue(elements.rpcUrl.value, "RPC URL")),
    });

    const result = await verifyWalrusBatchTreeSignatures({
      tree: state.loadedTree,
      verifierContractAddress: requireValue(
        elements.verifierContractAddress.value,
        "Verifier contract address",
      ),
      publicClient,
    });

    const verifiedCount = result.results.filter(entry => entry.verified === true).length;
    const invalidCount = result.results.filter(entry => entry.verified === false).length;
    const erroredCount = result.results.filter(entry => entry.verified === null).length;

    elements.verificationOutput.textContent = JSON.stringify(
      {
        mode: "full-blob",
        blobId: result.blobId,
        merkleRoot: result.merkleRoot,
        verifiedCount,
        invalidCount,
        erroredCount,
        results: result.results,
      },
      null,
      2,
    );

    setStatus(
      `Verified ${result.results.length} item(s).\nValid: ${verifiedCount}, Invalid: ${invalidCount}, Errors: ${erroredCount}`,
      invalidCount === 0 && erroredCount === 0 ? "success" : "error",
    );
  } catch (error) {
    setStatus(formatError(error), "error");
  } finally {
    setButtonState(false);
  }
}

function renderItems(items) {
  if (!items.length) {
    elements.itemsTableBody.innerHTML = '<tr><td colspan="7">Blob contains no items.</td></tr>';
    return;
  }

  elements.itemsTableBody.innerHTML = "";

  for (const item of items) {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${item.index}</td>
      <td class="mono">${escapeHtml(item.tee_id)}</td>
      <td class="mono">${escapeHtml(item.input_hash)}</td>
      <td class="mono">${escapeHtml(item.output_hash)}</td>
      <td class="mono">${escapeHtml(item.tee_signature)}</td>
      <td>${escapeHtml(item.tee_timestamp)}</td>
      <td><button class="secondary" data-index="${item.index}">Use Item</button></td>
    `;

    const button = row.querySelector("button");
    button.addEventListener("click", () => {
      applyItemToForm(item);
    });

    elements.itemsTableBody.appendChild(row);
  }
}

function applyItemToForm(item) {
  state.selectedItem = item;
  elements.teeId.value = item.tee_id;
  elements.inputHash.value = item.input_hash;
  elements.outputHash.value = item.output_hash;
  elements.teeSignature.value = item.tee_signature;
  elements.teeTimestamp.value = item.tee_timestamp;
  elements.signatureEncoding.value = "hex";
  elements.selectedPayloadOutput.textContent = JSON.stringify(item, null, 2);
  setStatus(`Loaded blob item #${item.index} into the form.`, "success");
}

function readFormItem() {
  const teeId = normalizeBytes32(elements.teeId.value, "tee_id");
  const inputHash = normalizeBytes32(elements.inputHash.value, "input_hash");
  const outputHash = normalizeBytes32(elements.outputHash.value, "output_hash");
  const teeTimestamp = normalizeUintString(elements.teeTimestamp.value, "tee_timestamp");
  const teeSignature = encodeWalrusSignature(
    requireValue(elements.teeSignature.value, "tee_signature"),
    elements.signatureEncoding.value,
  );

  return {
    index: state.selectedItem?.index ?? -1,
    tee_id: teeId,
    input_hash: inputHash,
    output_hash: outputHash,
    tee_signature: teeSignature,
    tee_timestamp: teeTimestamp,
    tuple: [teeId, inputHash, outputHash, teeSignature, teeTimestamp],
  };
}

function setStatus(message, kind = "success") {
  elements.status.textContent = message;
  elements.status.className = `status ${kind}`;
}

function setButtonState(isBusy) {
  elements.fetchBlobButton.disabled = isBusy;
  elements.verifyItemButton.disabled = isBusy;
  elements.verifyBlobButton.disabled = isBusy;
}

function requireValue(value, label) {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} is required.`);
  }
  return normalized;
}

function normalizeAddress(value, label) {
  const normalized = normalizeHex(requireValue(value, label), label);
  if (!/^0x[0-9a-fA-F]{40}$/.test(normalized)) {
    throw new Error(`${label} must be a valid EVM address.`);
  }
  return normalized;
}

function normalizeBytes32(value, label) {
  const normalized = normalizeHex(requireValue(value, label), label);
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error(`${label} must be a bytes32 hex string.`);
  }
  return normalized;
}

function normalizeUintString(value, label) {
  const normalized = requireValue(value, label);
  if (!/^[0-9]+$/.test(normalized)) {
    throw new Error(`${label} must be a base-10 uint256 string.`);
  }
  return normalized;
}

function normalizeHex(value) {
  return value.startsWith("0x") ? value : `0x${value}`;
}

function formatError(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
