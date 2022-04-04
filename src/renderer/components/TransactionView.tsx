import * as sol from '@solana/web3.js';
import { netToURL } from 'common/strings';
import { useEffect, useState } from 'react';
import { Net } from 'types/types';

function TransactionView(props: { net: Net }) {
  const { net } = props;
  const [latestProcessedSlot, setLatestProcessedSlot] = useState(0);
  useEffect(() => {
    const blockInterval = setInterval(async () => {
      const solConn = new sol.Connection(netToURL(net));
      const blockProduction = await solConn.getBlockProduction();
      const blocks = await solConn.getBlocks(
        latestProcessedSlot,
        blockProduction.context.slot - 1
      );
      blocks.forEach(async (block) => {
        const blockDetails = await solConn.getBlock(block);
        blockDetails?.transactions.forEach(async (txn) => {
          const parsedTxn = await solConn.getParsedTransactions(
            txn.transaction.signatures
          );
          const instructions = parsedTxn[0]?.transaction.message.instructions;
          if (instructions) {
            const parsedInstruction = instructions[0] as sol.ParsedInstruction;
            if (parsedInstruction.program !== 'vote') {
              console.log(parsedInstruction);
            }
          }
        });
      });
      setLatestProcessedSlot(blockProduction.context.slot);
    }, 1000);

    return () => {
      window.clearInterval(blockInterval);
    };
  }, [latestProcessedSlot, net]);

  return <>{latestProcessedSlot}</>;
}
export default TransactionView;
