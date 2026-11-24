import { cookies } from 'next/headers';
import { cookieAccount, sessionName } from '../src/auth';
import { Dashboard } from './dashboard';

export default async function Page() {
  const account = cookieAccount((await cookies()).get(sessionName)?.value);
  return <Dashboard account={account} />;
}
