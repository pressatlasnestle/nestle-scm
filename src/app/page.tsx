import { redirect } from "next/navigation";

// The admin console has no dedicated dashboard yet — send everyone to the
// first settings section they can always reach.
export default function Home() {
  redirect("/media-universe");
}
