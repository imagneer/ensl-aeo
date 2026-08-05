'use client'

import { createClient } from '@supabase/supabase-js'
import { useEffect, useState } from 'react'

// Supabase 클라이언트 초기화
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
)

// 컴포넌트 정의
export default function Todos() {
  const [todos, setTodos] = useState([])
  const [newTask, setNewTask] = useState('')

    useEffect(() => {
    async function fetchTodos() {
      const { data } = await supabase.from('todos').select('*')
      setTodos(data || [])
    }
    fetchTodos()
  }, [])

    const handleSubmit = async (e) => {
        e.preventDefault()
        if (newTask.trim()) {
             const { data, error } = await supabase
             .from('todos')
             .insert({ task: newTask})
             .select()

            if (error) {
                console.log('Error inserting task:', error)
             } else {
                setTodos([...todos, ...data])
                setNewTask('')
             }
        }
    }

  return (
    <div>
      <h1>나의 할 일 목록</h1>
      <form onSubmit={handleSubmit}>
        <input type="text" value={newTask} onChange={(e) => setNewTask(e.target.value)}
        />
        <button type="submit">Add Task</button>
        </form>
        {todos.map((todo) => (
        <p key={todo.id}>{todo.task}</p>
      ))}
    </div>
  )
}