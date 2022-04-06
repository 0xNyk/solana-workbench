import { faPencil, faSignature } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import * as sol from '@solana/web3.js';
import { netToURL, prettifyPubkey } from 'common/strings';
import { useEffect, useState } from 'react';
import { Badge, ListGroup, ListGroupItem } from 'react-bootstrap';
import { Net } from 'types/types';

type InstructionAccountData = {
  instruction: sol.ParsedInstruction;
  accountKeys: sol.ParsedMessageAccount | undefined;
};

function TransactionView(props: { net: Net }) {
  const { net } = props;
  const [latestProcessedSlot, setLatestProcessedSlot] = useState(0);
  const [renderedParsedTransactions, setRenderedParsedTransactions] = useState<
    (sol.ParsedTransactionWithMeta | null)[][]
  >([]);
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
          const parsedTxns = await solConn.getParsedTransactions(
            txn.transaction.signatures
          );
          if (parsedTxns && parsedTxns[0]) {
            const { instructions } = parsedTxns[0].transaction.message;
            if (instructions) {
              const parsedInstruction =
                instructions[0] as sol.ParsedInstruction;
              if (parsedInstruction.program !== 'vote') {
                const newRenderedParsedTransactions = [
                  ...renderedParsedTransactions,
                  parsedTxns,
                ];
                setRenderedParsedTransactions(newRenderedParsedTransactions);
              }
            }
          }
        });
      });
      setLatestProcessedSlot(blockProduction.context.slot);
    }, 1000);

    return () => {
      window.clearInterval(blockInterval);
    };
  }, [net]);

  const pillify = (instruction: sol.ParsedInstruction) => {
    const { parsed, program, programId } = instruction;
    const { info } = parsed;
    return <pre>{JSON.stringify(instruction, null, 2)}</pre>;
  };

  const accountInstructionData = renderedParsedTransactions.map(
    (parsedTxns) => {
      const accountsAndInstructions: InstructionAccountData[] = [];
      parsedTxns[0]?.transaction.message.instructions.forEach(
        (instruction, i) => {
          accountsAndInstructions.push({
            accountKeys: parsedTxns[0]?.transaction.message.accountKeys[i],
            instruction: instruction as sol.ParsedInstruction,
          });
        }
      );
      return accountsAndInstructions;
    }
  );

  return (
    <ListGroup>
      {accountInstructionData.map((data: InstructionAccountData[]) => {
        return (
          <ListGroupItem>
            {data.map((d) => {
              return (
                <div className="ms-2 me-auto">
                  <div className="fw-bold">
                    {d.instruction.program}.{d.instruction.parsed.type}
                  </div>
                  <div>
                    <code>
                      {prettifyPubkey(d.accountKeys?.pubkey.toString())}
                    </code>
                    {d.accountKeys?.writable && (
                      <FontAwesomeIcon icon={faPencil} />
                    )}
                    {d.accountKeys?.signer && (
                      <FontAwesomeIcon icon={faSignature} />
                    )}
                  </div>
                </div>
              );
            })}
          </ListGroupItem>
        );
      })}
    </ListGroup>
  );
}
export default TransactionView;
