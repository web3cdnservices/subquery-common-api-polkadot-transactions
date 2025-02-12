import { SubstrateExtrinsic } from "@subql/types";
import { AssetTransfer, HistoryElement, Transfer, Swap } from "../types";
import {
  getAssetIdFromMultilocation,
  getEventData,
  callFromProxy,
  callsFromBatch,
  calculateFeeAsString,
  extrinsicIdFromBlockAndIdx,
  eventRecordToSubstrateEvent,
  isBatch,
  isProxy,
  timestamp,
  isNativeTransfer,
  isAssetTransfer,
  isOrmlTransfer,
  isSwapExactTokensForTokens,
  isSwapTokensForExactTokens,
  isNativeTransferAll,
  isOrmlTransferAll,
  isEvmTransaction,
  isEvmExecutedEvent,
  isAssetTxFeePaidEvent,
  isEquilibriumTransfer,
} from "./common";
import { CallBase } from "@polkadot/types/types/calls";
import { AnyTuple } from "@polkadot/types/types/codec";
import { u64 } from "@polkadot/types";
import { ethereumEncode } from "@polkadot/util-crypto";

type TransferData = {
  isTransferAll: boolean;
  transfer: Transfer | AssetTransfer | Swap;
};

export async function handleHistoryElement(
  extrinsic: SubstrateExtrinsic,
): Promise<void> {
  const { isSigned } = extrinsic.extrinsic;

  if (isSigned) {
    let failedTransfers = findFailedTransferCalls(extrinsic);
    if (failedTransfers != null) {
      await saveFailedTransfers(failedTransfers, extrinsic);
    } else {
      await saveExtrinsic(extrinsic);
    }
  } else if (
    isEvmTransaction(extrinsic.extrinsic.method) &&
    extrinsic.success
  ) {
    await saveEvmExtrinsic(extrinsic);
  }
}

function createHistoryElement(
  extrinsic: SubstrateExtrinsic,
  address: string,
  suffix: string = "",
  hash?: string,
) {
  let extrinsicHash = hash || extrinsic.extrinsic.hash.toString();
  let blockNumber = extrinsic.block.block.header.number.toNumber();
  let extrinsicIdx = extrinsic.idx;
  let extrinsicId = extrinsicIdFromBlockAndIdx(blockNumber, extrinsicIdx);
  let blockTimestamp = timestamp(extrinsic.block);

  const historyElement = HistoryElement.create({
    id: `${extrinsicId}${suffix}`,
    blockNumber,
    timestamp: blockTimestamp,
    address,
    extrinsicHash,
    extrinsicIdx,
  });

  return historyElement;
}

function addTransferToHistoryElement(
  element: HistoryElement,
  transfer: Transfer | AssetTransfer | Swap,
) {
  if ("assetIdIn" in transfer) {
    element.swap = transfer;
  } else if ("assetId" in transfer) {
    element.assetTransfer = transfer;
  } else {
    element.transfer = transfer;
  }
}

async function saveFailedTransfers(
  transfers: Array<TransferData>,
  extrinsic: SubstrateExtrinsic,
): Promise<void> {
  for (const { isTransferAll, transfer } of transfers) {
    const isSwap = "assetIdIn" in transfer;
    const from = isSwap ? transfer.sender : transfer.from;
    const to = isSwap ? transfer.receiver : transfer.to;
    const elementFrom = createHistoryElement(extrinsic, from, `-from`);
    addTransferToHistoryElement(elementFrom, transfer);

    // FIXME: Try to find more appropriate way to handle failed transferAll events
    if ((!isTransferAll && !isSwap) || from.toString() != to.toString()) {
      const elementTo = createHistoryElement(extrinsic, to, `-to`);
      addTransferToHistoryElement(elementTo, transfer);

      await elementTo.save();
      await elementFrom.save();
    }

    await elementFrom.save();
  }
}

async function saveExtrinsic(extrinsic: SubstrateExtrinsic): Promise<void> {
  const element = createHistoryElement(
    extrinsic,
    extrinsic.extrinsic.signer.toString(),
    "-extrinsic",
  );

  element.extrinsic = {
    hash: extrinsic.extrinsic.hash.toString(),
    module: extrinsic.extrinsic.method.section,
    call: extrinsic.extrinsic.method.method,
    success: extrinsic.success,
    fee: calculateFeeAsString(extrinsic),
  };
  await element.save();
}

async function saveEvmExtrinsic(extrinsic: SubstrateExtrinsic): Promise<void> {
  const executedEvent = extrinsic.events.find(isEvmExecutedEvent);
  if (!executedEvent) {
    return;
  }

  const addressFrom = ethereumEncode(executedEvent.event.data?.[0]?.toString());
  const hash = executedEvent.event.data?.[2]?.toString();
  const success = !!(executedEvent.event.data?.[3].toJSON() as any).succeed;

  const element = createHistoryElement(
    extrinsic,
    addressFrom,
    "-extrinsic",
    hash,
  );

  element.extrinsic = {
    hash,
    module: extrinsic.extrinsic.method.section,
    call: extrinsic.extrinsic.method.method,
    success,
    fee: calculateFeeAsString(extrinsic, addressFrom),
  };

  await element.save();
}

type TransferCallback = (
  isTransferAll: boolean,
  address: string,
  amount: any,
  assetId?: string,
) => Array<{ isTransferAll: boolean; transfer: Transfer }>;
type SwapCallback = (
  path: any[],
  amountId: any,
  amountOut: any,
  receiver: any,
) => Array<{ isTransferAll: boolean; transfer: Swap }>;

/// Success Transfer emits Transfer event that is handled at Transfers.ts handleTransfer()
function findFailedTransferCalls(
  extrinsic: SubstrateExtrinsic,
): Array<TransferData> | null {
  if (extrinsic.success) {
    return null;
  }

  let sender = extrinsic.extrinsic.signer;
  const transferCallback: TransferCallback = (
    isTransferAll,
    address,
    amount,
    assetId?,
  ) => {
    const transfer: Transfer = {
      amount: amount.toString(),
      from: sender.toString(),
      to: address,
      fee: calculateFeeAsString(extrinsic),
      eventIdx: -1,
      success: false,
    };

    if (assetId) {
      (transfer as AssetTransfer).assetId = assetId;
    }

    return [
      {
        isTransferAll,
        transfer,
      },
    ];
  };

  let assetIdFee = "native";
  let fee = calculateFeeAsString(extrinsic);
  let foundAssetTxFeePaid = extrinsic.block.events.find((e) =>
    isAssetTxFeePaidEvent(eventRecordToSubstrateEvent(e)),
  );
  if (foundAssetTxFeePaid !== undefined) {
    const [who, actual_fee, tip, rawAssetIdFee] = getEventData(
      eventRecordToSubstrateEvent(foundAssetTxFeePaid),
    );
    if ("interior" in rawAssetIdFee) {
      assetIdFee = getAssetIdFromMultilocation(rawAssetIdFee);
      fee = actual_fee.toString();
    }
  }
  const swapCallback: SwapCallback = (path, amountIn, amountOut, receiver) => {
    const assetIdIn = getAssetIdFromMultilocation(path[0], true);
    const assetIdOut = getAssetIdFromMultilocation(
      path[path["length"] - 1],
      true,
    );

    if (assetIdIn === undefined || assetIdOut === undefined) {
      return [];
    }

    const swap: Swap = {
      assetIdIn: assetIdIn,
      amountIn: amountIn.toString(),
      assetIdOut: assetIdOut,
      amountOut: amountOut.toString(),
      sender: sender.toString(),
      receiver: receiver.toString(),
      assetIdFee: assetIdFee,
      fee: fee,
      eventIdx: -1,
      success: false,
    };

    return [
      {
        isTransferAll: false,
        transfer: swap,
      },
    ];
  };

  let transferCalls = determineTransferCallsArgs(
    extrinsic.extrinsic.method,
    transferCallback,
    swapCallback,
  );
  if (transferCalls.length == 0) {
    return null;
  }

  return transferCalls;
}

function determineTransferCallsArgs(
  causeCall: CallBase<AnyTuple>,
  transferCallback: TransferCallback,
  swapCallback: SwapCallback,
): Array<TransferData> {
  if (isNativeTransfer(causeCall)) {
    return transferCallback(false, ...extractArgsFromTransfer(causeCall));
  } else if (isAssetTransfer(causeCall)) {
    return transferCallback(false, ...extractArgsFromAssetTransfer(causeCall));
  } else if (isOrmlTransfer(causeCall)) {
    return transferCallback(false, ...extractArgsFromOrmlTransfer(causeCall));
  } else if (isEquilibriumTransfer(causeCall)) {
    return transferCallback(
      false,
      ...extractArgsFromEquilibriumTransfer(causeCall),
    );
  } else if (isNativeTransferAll(causeCall)) {
    return transferCallback(true, ...extractArgsFromTransferAll(causeCall));
  } else if (isOrmlTransferAll(causeCall)) {
    return transferCallback(true, ...extractArgsFromOrmlTransferAll(causeCall));
  } else if (isSwapExactTokensForTokens(causeCall)) {
    return swapCallback(...extractArgsFromSwapExactTokensForTokens(causeCall));
  } else if (isSwapTokensForExactTokens(causeCall)) {
    return swapCallback(...extractArgsFromSwapTokensForExactTokens(causeCall));
  } else if (isBatch(causeCall)) {
    return callsFromBatch(causeCall)
      .map((call) => {
        return determineTransferCallsArgs(
          call,
          transferCallback,
          swapCallback,
        ).map((value, index, array) => {
          return value;
        });
      })
      .flat();
  } else if (isProxy(causeCall)) {
    let proxyCall = callFromProxy(causeCall);
    return determineTransferCallsArgs(
      proxyCall,
      transferCallback,
      swapCallback,
    );
  } else {
    return [];
  }
}

function extractArgsFromTransfer(call: CallBase<AnyTuple>): [string, bigint] {
  const [destinationAddress, amount] = call.args;

  return [destinationAddress.toString(), (amount as u64).toBigInt()];
}

function extractArgsFromAssetTransfer(
  call: CallBase<AnyTuple>,
): [string, bigint, string] {
  const [assetId, destinationAddress, amount] = call.args;

  return [
    destinationAddress.toString(),
    (amount as u64).toBigInt(),
    assetId.toString(),
  ];
}

function extractArgsFromOrmlTransfer(
  call: CallBase<AnyTuple>,
): [string, bigint, string] {
  const [destinationAddress, currencyId, amount] = call.args;

  return [
    destinationAddress.toString(),
    (amount as u64).toBigInt(),
    currencyId.toHex().toString(),
  ];
}

function extractArgsFromEquilibriumTransfer(
  call: CallBase<AnyTuple>,
): [string, bigint, string] {
  const [assetId, destinationAddress, amount] = call.args;

  return [
    destinationAddress.toString(),
    (amount as u64).toBigInt(),
    assetId.toString(),
  ];
}

function extractArgsFromTransferAll(
  call: CallBase<AnyTuple>,
): [string, bigint] {
  const [destinationAddress] = call.args;

  return [destinationAddress.toString(), BigInt(0)];
}

function extractArgsFromOrmlTransferAll(
  call: CallBase<AnyTuple>,
): [string, bigint, string] {
  const [destinationAddress, currencyId] = call.args;

  return [
    destinationAddress.toString(),
    BigInt(0),
    currencyId.toHex().toString(),
  ];
}

function extractArgsFromSwapExactTokensForTokens(
  call: CallBase<AnyTuple>,
): [any, any, any, any] {
  const [path, amountIn, amountOut, receiver, _] = call.args;

  return [path, amountIn, amountOut, receiver];
}

function extractArgsFromSwapTokensForExactTokens(
  call: CallBase<AnyTuple>,
): [any, any, any, any] {
  const [path, amountOut, amountIn, receiver, _] = call.args;

  return [path, amountIn, amountOut, receiver];
}
