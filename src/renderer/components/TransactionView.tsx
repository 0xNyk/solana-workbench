import * as sol from '@solana/web3.js';
import { netToURL } from 'common/strings';
import { useEffect, useState } from 'react';
import { Net } from 'types/types';

function TransactionView(props: { net: Net }) {
  const { net } = props;
  const [latestProcessedSlot, setLatestProcessedSlot] = useState(0);
  useEffect(() => {
    const solConn = new sol.Connection(netToURL(net));
    (async () => {
      const blockProduction = await solConn.getBlockProduction();
      setLatestProcessedSlot(blockProduction.context.slot);
    })();
  }, [net]);
  return <>{latestProcessedSlot}</>;
}
export default TransactionView;
